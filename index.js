require('dotenv').config()

const path = require('path')
const fs = require('fs')
const ncp = require('ncp')
const ftpClient = require('ftp')
const exec = require('child_process').exec
const dircompare = require('dir-compare')
const { performance } = require('perf_hooks')

const runCommand = (cmd, dir, muteErrors) => {
    return new Promise((resolve, reject) => {
        const proc = exec(cmd, { cwd: dir })
        proc.stdout.on('data', data => console.log(data))
        if(!muteErrors) proc.stderr.on('data', data => console.error(data))
        proc.on('exit', code => code === 0 ? resolve() : reject())
    })
}

const addLeadingZero = (number) => number < 10 ? '0' + number : number

const reportNextStep = (message) => console.log('\x1b[36m%s\x1b[0m', message)

const reportSuccess = (message, t0) => {
    const t1 = performance.now()
    const diff = (t1 - t0) / 1000
    const min = addLeadingZero(Math.floor(diff / 60))
    const sec = addLeadingZero(Math.floor(diff - min * 60))
    console.log('\x1b[33m%s\x1b[0m', message)
    console.log(`Current time: ${new Date().toString()}`)
    console.log(`Execution time: ${min}:${sec}`)
    process.exit(0)
}

const reportError = (error) => {
    console.log('\x1b[31mERROR: %s\x1b[0m', error)
    process.exit(1)
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
            resolve(diff)
        }catch (e) {
            reject()
        }
    })
}

const syncFtpServer = (changes) => {
    reportNextStep('Connecting to the FTP server...')
    return new Promise((resolve) => {
        const ftp = new ftpClient()
        ftp.on('ready', () => {
            reportNextStep('Uploading files...')
            let runningActions = 0
            changes.diffSet.forEach(file => {
                if(file.state === 'left' || file.state === 'distinct') {
                    runningActions++
                    uploadFileToFtp(ftp, file, () => runningActions--)
                }
                if(file.state === 'right') {
                    runningActions++
                    deleteFileFromFtp(ftp, file, () => runningActions--)
                }
            })
            const resolveWhenActionsHaveBeenCompleted = () => {
                if(runningActions === 0) {
                    resolve()
                }else{
                    setTimeout(resolveWhenActionsHaveBeenCompleted, 500)
                }
            }
            resolveWhenActionsHaveBeenCompleted()
        })
        ftp.on('error', (err) => reportError(`Critical FTP connection error: ${err}`))
        ftp.connect({
            host: process.env.HOST,
            user: process.env.USER,
            password: process.env.PASSWORD
        })
    })
}

const uploadFileToFtp = (ftp, file, callback) => {
    const source = path.join(file.path1, file.name1)
    const destination = path.join(file.relativePath, file.name1).replace(/\\/g, '/')
    const isFile = fs.statSync(source).isFile()
    if(isFile) {
        ftp.put(source, destination, (err) => {
            console.log(`UPLOAD "${source}" >>> "${destination}"`)
            err ? reportError(`(ftp-put) ${err} "${source}" "${destination}"`) : callback()
        })
    }else{
        ftp.mkdir(destination, true, (err) => {
            console.log(`MKDIR  "${destination}"`)
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
            callback()
        })
    }else{
        ftp.rmdir(target, { recursive: true }, () => {
            console.log(`RMDIR  "${target}"`)
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

const t0 = performance.now()
pullGitRepository().then(() => {
    installDependencies().then(() => {
        buildGatsbyWebsite().then(() => {
            compareBuildWithPreviousData().then(diff => {
                if(diff.same) {
                    reportSuccess('Already up to date!', t0)
                }else{
                    syncFtpServer(diff).then(() => {
                        saveCurrentSave().then(() => {
                            reportSuccess('Website deployed!', t0)
                        }).catch(error => reportError(error))
                    }).catch(error => reportError(error))
                }
            }).catch(() => reportError('dir-compare'))
        }).catch(() => reportError('gatsby build'))
    }).catch(() => reportError('npm install'))
}).catch(() => reportError('git pull'))
