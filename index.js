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

const consoleBg = {
    normal: '',
    success: '\x1b[33m',
    error: '\x1b[31m',
    nextStep: '\x1b[36m'
}

const emailBg = {
    normal: '#ffffff',
    success: '#297933',
    error: '#b41713',
    nextStep: '#0a6a6a'
}

const addLeadingZero = number => number < 10 ? '0' + number : number

const log = (message, consoleType = consoleBg.normal, emailType = emailBg.normal) => {
    if(consoleType || consoleType === consoleBg.normal) console.log(`${consoleType}%s\x1b[0m`, message)
    if(emailType) {
        if(emailType === emailBg.normal) {
            emailContent += `${message}<br/>`
        }else{
            const style = `padding: 2px 5px; background-color: ${emailType}; color: #ffffff`
            emailContent += `<div style="${style}">${message}</div>`
        }
    }
}

const sendEmail = async (success, message) => {
    const globalStyle = `font-family: 'Consolas', 'Lucida Console'`
    const style = `padding: 2px 5px; background-color: ${success ? emailBg.success : emailBg.error}; color: #ffffff`
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
        html: `
            <div style="${globalStyle}">
                <div style="${style}">${message}</div>
                Current time: ${new Date().toString()}<br/>
                Execution time: ${min}:${sec}<br/><br/>
                <b>Console output:</b><br/>
                ${emailContent}
            </div>
        `
    })
}

const reportNextStep = message => log(message, consoleBg.nextStep, emailBg.nextStep)

const reportSuccess = message => {
    const t1 = performance.now()
    const diff = (t1 - t0) / 1000
    const min = addLeadingZero(Math.floor(diff / 60))
    const sec = addLeadingZero(Math.floor(diff - min * 60))
    log(message, consoleBg.success, null)
    log(`Current time: ${new Date().toString()}`, consoleBg.normal, null)
    log(`Execution time: ${min}:${sec}`, consoleBg.normal, null)
    sendEmail(true, message).then(() => process.exit(0))
}

const reportError = (error) => {
    log(`ERROR: ${error}`, consoleBg.error, emailBg.normal)
    sendEmail(false, error).then(() => process.exit(1))
}

const runCommand = (cmd, dir, muteErrors) => {
    return new Promise(resolve => {
        const proc = exec(cmd, { cwd: dir })
        proc.stdout.on('data', data => log(data))
        if(!muteErrors) proc.stderr.on('data', data => log(data))
        proc.on('exit', code => code === 0 ? resolve() : reportError(`Command "${cmd}"`))
    })
}

const pullGitRepository = () => {
    reportNextStep('Pulling changes...')
    return new Promise(resolve => {
        runCommand('git pull', './repo', false).then(() => {
            log(`Current commit:`)
            runCommand('git log -1', './repo', false).then(() => resolve())
        })
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
                compareContent: true
            })
            log(`Statistics: equal: ${diff.equal}, distinct: ${diff.distinct}, new: ${diff.left}, old: ${diff.right}`)
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
        ftp.access({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD
        }).then(() => {
            log('Connected!')
            reportNextStep('Uploading files...')
            changedFiles = changes.diffSet.filter(obj => ['left', 'right', 'distinct'].indexOf(obj.state) >= 0)
            changedFilesCount = changedFiles.length
            nextFile(ftp, () => resolve())
        }).catch(err => reportError(`Critical FTP connection error (message: ${err})`))
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
        log(`${getUploadPercent()} UPLOAD "${destination}"`)
        ftp.uploadFrom(source, destination).then(() => {
            callback()
        }).catch(() => reportError(`(ftp-put) "${source}" >>> "${destination}"`))
    }else{
        log(`${getUploadPercent()} MKDIR  "${destination}"`)
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
        log(`${getUploadPercent()} DELETE "${target}"`)
        ftp.remove(target).then(() => callback())
    }else{
        log(`${getUploadPercent()} RMDIR  "${target}"`)
        ftp.removeDir(target).then(() => callback())
    }
}

const saveCurrentState = () => {
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
                        saveCurrentState().then(() => {
                            reportSuccess('Website deployed!')
                        })
                    })
                }
            })
        })
    })
})
