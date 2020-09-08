require('dotenv').config()

const path = require('path')
const fs = require('fs')
const ncp = require('ncp')
const basicFtp = require('basic-ftp')
const exec = require('child_process').exec
const dircompare = require('dir-compare')
const nodemailer = require("nodemailer")
const { performance } = require('perf_hooks')

const t0 = performance.now()
let emailContent = ''
let changedFiles = []
let changedFilesCount = 0

const bgColor = {
    NONE: '#ffffff',
    RED: '#b41713',
    GREEN: '#297933',
    BLUE: '#0a6a6a'
}

const addToEmailContent = (message, color = bgColor.NONE) => {
    if(color === bgColor.NONE) {
        emailContent += `${message}<br/>`
    }else{
        const style = `padding: 2px 5px; background-color: ${color}; color: #ffffff`
        emailContent += `<div style="${style}">${message}</div>`
    }
}

const sendEmail = async (success, message) => {
    const globalStyle = `font-family: 'Consolas'`
    const style = `padding: 2px 5px; background-color: ${success ? bgColor.GREEN : bgColor.RED}; color: #ffffff`
    const t1 = performance.now()
    const diff = (t1 - t0) / 1000
    const min = addLeadingZero(Math.floor(diff / 60))
    const sec = addLeadingZero(Math.floor(diff - min * 60))
    let transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: process.env.MAIL_PORT,
        secure: process.env.MAIL_SECURE === 'true',
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASSWORD
        }
    })
    await transporter.sendMail({
        from: `Gatsby Deployer <${process.env.MAIL_USER}>`,
        to: process.env.MAIL_DESTINATION_ADDRESS,
        subject: success ? `Website successfully deployed` : `Website deploy failed!`,
        html: `<div style="${globalStyle}"><div style="${style}">${message}</div>Current time: ${new Date().toString()}<br/>Execution time: ${min}:${sec}<br/><br/><b>Console output:</b><br/>${emailContent}</div>`
    })
}

const runCommand = (cmd, dir, muteErrors) => {
    return new Promise(resolve => {
        const proc = exec(cmd, { cwd: dir })
        proc.stdout.on('data', data => {
            console.log(data)
            addToEmailContent(data, bgColor.NONE)
        })
        if(!muteErrors) proc.stderr.on('data', data => {
            console.error(data)
            addToEmailContent(data, bgColor.NONE)
        })
        proc.on('exit', code => code === 0 ? resolve() : reportError(`Command "${cmd}"`))
    })
}

const addLeadingZero = number => number < 10 ? '0' + number : number

const reportNextStep = message => {
    console.log('\x1b[36m%s\x1b[0m', message)
    addToEmailContent(message, bgColor.BLUE)
}

const reportSuccess = message => {
    const t1 = performance.now()
    const diff = (t1 - t0) / 1000
    const min = addLeadingZero(Math.floor(diff / 60))
    const sec = addLeadingZero(Math.floor(diff - min * 60))
    console.log('\x1b[33m%s\x1b[0m', message)
    console.log(`Current time: ${new Date().toString()}`)
    console.log(`Execution time: ${min}:${sec}`)
    sendEmail(true, message).then(() => process.exit(0))
}

const reportError = (error) => {
    console.log('\x1b[31mERROR: %s\x1b[0m', error)
    sendEmail(false, error).then(() => process.exit(1))
}

const pullGitRepository = () => {
    reportNextStep('Pulling changes...')
    return new Promise(resolve => {
        runCommand('git pull', './repo', false).then(() => {
            const txt = `Current commit:`
            console.log(txt)
            addToEmailContent(txt, bgColor.NONE)
            runCommand('git log -1', './repo', false).then(() => {
                resolve()
            }).catch(() => reportError('git log -1'))
        }).catch(() => reportError('git pull'))
    })
}

const installDependencies = () => {
    reportNextStep('Installing dependencies...')
    return runCommand('npm install', './repo', true)
}

const buildGatsbyWebsite = () => {
    reportNextStep('Building Gatsby website...')
    return runCommand('gatsby build', './repo', false)
}

const compareBuildWithPreviousData = () => {
    reportNextStep('Comparing build with previous data...')
    return new Promise(resolve => {
        try {
            fs.mkdirSync('./currentFTP', { recursive: true })
            const diff = dircompare.compareSync('./repo/public', './currentFTP', {
                compareSize: true,
                compareContent: true,
                //compareDate: true,
            })
            const txt = `Statistics: equal: ${diff.equal}, distinct: ${diff.distinct}, new: ${diff.left}, old: ${diff.right}`
            console.log(txt)
            addToEmailContent(txt, bgColor.NONE)
            resolve(diff)
        }catch (e) {
            reportError(`diff-compare (message: ${e})`)
        }
    })
}

const syncFtpServer = changes => {
    reportNextStep('Connecting to the FTP server...')
    return new Promise(resolve => {
        const ftp = new basicFtp.Client()
        try {
            ftp.access({
                host: process.env.FTP_HOST,
                user: process.env.FTP_USER,
                password: process.env.FTP_PASSWORD
            }).then(() => {
                console.log('Connected!')
                addToEmailContent('Connected!', bgColor.NONE)
                reportNextStep('Uploading files...')
                changedFiles = changes.diffSet.filter(obj => ['left', 'right', 'distinct'].indexOf(obj.state) >= 0)
                changedFilesCount = changedFiles.length
                nextFile(ftp, () => resolve())
            })
        }catch (e) {
            reportError(`Critical FTP connection error (message: ${e})`)
        }
    })
}

const nextFile = (ftp, callback) => {
    if(changedFiles.length > 0) {
        const file = changedFiles.shift()
        if(file.state === 'left' || file.state === 'distinct') {
            uploadFileToFtp(ftp, file, () => nextFile(ftp, callback))
        }
        if(file.state === 'right') {
            deleteFileFromFtp(ftp, file, () => nextFile(ftp, callback))
        }
    }else{
        callback()
    }
}

const getUploadPercent = () => {
    const p = Math.round((changedFilesCount - changedFiles.length) * 100 / changedFilesCount)
    let s = '['
    if(p < 10) s+= ' '
    if(p < 100) s+= ' '
    s += p + '%]'
    return s
}

const uploadFileToFtp = (ftp, file, callback) => {
    const source = path.join(file.path1, file.name1)
    const destination = path.join(file.relativePath, file.name1).replace(/\\/g, '/')
    const isFile = fs.statSync(source).isFile()
    if(isFile) {
        const txt = `${getUploadPercent()} UPLOAD "${destination}"`
        console.log(txt)
        addToEmailContent(txt, bgColor.NONE)
        ftp.uploadFrom(source, destination).then(() => {
            callback()
        }).catch(() => reportError(`(ftp-put) "${source}" >>> "${destination}"`))
    }else{
        const txt = `${getUploadPercent()} MKDIR  "${destination}"`
        console.log(txt)
        addToEmailContent(txt, bgColor.NONE)
        ftp.ensureDir(destination).then(() => {
            ftp.cd('/').then(() => {
                callback()
            }).catch(() => reportError(`(ftp-mkdir) "${destination}"`))
        }).catch(() => reportError(`(ftp-mkdir) "${destination}"`))
    }
}

const deleteFileFromFtp = (ftp, file, callback) => {
    const targetOnPc = path.join(file.relativePath, file.name2)
    const target = path.join(file.relativePath, file.name2).replace(/\\/g, '/')
    const isFile = fs.statSync(targetOnPc).isFile()
    if(isFile) {
        const txt = `${getUploadPercent()} DELETE "${target}"`
        console.log(txt)
        addToEmailContent(txt, bgColor.NONE)
        ftp.remove(target).then(() => callback())
    }else{
        const txt = `${getUploadPercent()} RMDIR  "${target}"`
        console.log(txt)
        addToEmailContent(txt, bgColor.NONE)
        ftp.removeDir(target).then(() => callback())
    }
}

const saveCurrentSave = () => {
    reportNextStep('Saving current state...')
    return new Promise(resolve => {
        fs.rmdir('./currentFTP', { recursive: true }, err => {
            if(err) reportError('rmdir currentFTP')
            fs.mkdir('./currentFTP', { recursive: true }, err => {
                if(err) reportError('mkdir currentFTP')
                ncp('./repo/public', './currentFTP', err => {
                    err ? reportError('ncp') : resolve()
                })
            })
        })
    })
}

pullGitRepository().then(() => {
    installDependencies().then(() => {
        buildGatsbyWebsite().then(() => {
            compareBuildWithPreviousData().then(diff => {
                if(diff.same) {
                    reportSuccess('Already up to date!')
                }else{
                    syncFtpServer(diff).then(() => {
                        saveCurrentSave().then(() => {
                            reportSuccess('Website deployed!')
                        })
                    })
                }
            })
        })
    })
})
