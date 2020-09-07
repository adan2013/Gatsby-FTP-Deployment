require('dotenv').config()

const path = require('path')
const fs = require('fs')
const ncp = require('ncp')
const ftpClient = require('ftp')
const exec = require('child_process').exec
const dircompare = require('dir-compare')
const nodemailer = require("nodemailer")
const { performance } = require('perf_hooks')

const t0 = performance.now()
let emailContent = ''
let changedFiles = []

const bgColor = {
    NONE: '#ffffff',
    RED: '#b41713',
    GREEN: '#297933',
    BLUE: '#0a6a6a'
}

const addToEmailContent = (message, color) => {
    if(color === bgColor.NONE) {
        emailContent += `${message}<br/>`
    }else{
        const style = `padding: 2px 5px; background-color: ${color}; color: #ffffff`
        emailContent += `<div style="${style}">${message}</div>`
    }
}

const sendEmail = async (success, message) => {
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
        html: `<div style="${style}">${message}</div>Current time: ${new Date().toString()}<br/>Execution time: ${min}:${sec}<br/><br/><b>Console output:</b><br/>${emailContent}`
    })
}

const runCommand = (cmd, dir, muteErrors) => {
    return new Promise((resolve, reject) => {
        const proc = exec(cmd, { cwd: dir })
        proc.stdout.on('data', data => {
            console.log(data)
            addToEmailContent(data, bgColor.NONE)
        })
        if(!muteErrors) proc.stderr.on('data', data => {
            console.error(data)
            addToEmailContent(data, bgColor.NONE)
        })
        proc.on('exit', code => code === 0 ? resolve() : reject())
    })
}

const addLeadingZero = (number) => number < 10 ? '0' + number : number

const reportNextStep = (message) => {
    console.log('\x1b[36m%s\x1b[0m', message)
    addToEmailContent(message, bgColor.BLUE)
}

const reportSuccess = (message) => {
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
    return runCommand('git pull', './repo', false)
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
    return new Promise((resolve, reject) => {
        try {
            fs.mkdirSync('./currentFTP', { recursive: true })
            const diff = dircompare.compareSync('./repo/public', './currentFTP', {
                compareSize: true,
                compareContent: true,
                //compareDate: true,
            })
            console.log('Statistics: equal: %s, differences: %s, new files: %s, old files: %s', diff.equal, diff.differences, diff.left, diff.right)
            addToEmailContent(`Statistics: equal: ${diff.equal}, differences: ${diff.differences}, new files: ${diff.left}, old files: ${diff.right}`, bgColor.NONE)
            resolve(diff)
        }catch (e) {
            reject()
        }
    })
}

const syncFtpServer = (changes) => {
    reportNextStep('Connecting to the FTP server...')
    return new Promise((resolve, reject) => {
        const ftp = new ftpClient()
        ftp.on('ready', () => {
            console.log('Connected!')
            addToEmailContent('Connected!', bgColor.NONE)
            reportNextStep('Uploading files...')
            changedFiles = JSON.parse(JSON.stringify(changes.diffSet))
            nextFile(ftp, () => resolve())
        })
        ftp.on('error', (err) => reject(`Critical FTP connection error: ${err}`))
        ftp.connect({
            host: process.env.FTP_HOST,
            user: process.env.FTP_USER,
            password: process.env.FTP_PASSWORD
        })
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

const uploadFileToFtp = (ftp, file, callback) => {
    const source = path.join(file.path1, file.name1)
    const destination = path.join(file.relativePath, file.name1).replace(/\\/g, '/')
    const isFile = fs.statSync(source).isFile()
    if(isFile) {
        ftp.put(source, destination, (err) => {
            console.log(`UPLOAD "${source}" >>> "${destination}"`)
            addToEmailContent(`UPLOAD "${source}" >>> "${destination}"`, bgColor.NONE)
            err ? reportError(`(ftp-put) ${err} "${source}" "${destination}"`) : callback()
        })
    }else{
        ftp.mkdir(destination, true, (err) => {
            console.log(`MKDIR  "${destination}"`)
            addToEmailContent(`MKDIR  "${destination}"`, bgColor.NONE)
            err ? reportError(`(ftp-mkdir) ${err} "${destination}"`) : callback()
        })
    }
}

const deleteFileFromFtp = (ftp, file, callback) => {
    const targetOnPc = path.join(file.relativePath, file.name2)
    const target = path.join(file.relativePath, file.name2).replace(/\\/g, '/')
    const isFile = fs.statSync(targetOnPc).isFile()
    if(isFile) {
        ftp.delete(target, () => {
            console.log(`DELETE "${target}"`)
            addToEmailContent(`DELETE "${target}"`, bgColor.NONE)
            callback()
        })
    }else{
        ftp.rmdir(target, { recursive: true }, () => {
            console.log(`RMDIR  "${target}"`)
            addToEmailContent(`RMDIR  "${target}"`, bgColor.NONE)
            callback()
        })
    }
}

const saveCurrentSave = () => {
    reportNextStep('Saving current state...')
    return new Promise((resolve, reject) => {
        fs.rmdir('./currentFTP', { recursive: true }, (err) => {
            if(err) reject('rmdir currentFTP')
            fs.mkdir('./currentFTP', { recursive: true }, (err) => {
                if(err) reject('mkdir currentFTP')
                ncp('./repo/public', './currentFTP', (err) => {
                    err ? reject('ncp') : resolve()
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
                        }).catch(error => reportError(error))
                    }).catch(error => reportError('ftp ' + error))
                }
            }).catch(() => reportError('dir-compare'))
        }).catch(() => reportError('gatsby build'))
    }).catch(() => reportError('npm install'))
}).catch(() => reportError('git pull'))
