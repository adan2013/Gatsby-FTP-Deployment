require('dotenv').config()

const path = require('path')
const fs = require('fs')
const exec = require('child_process').exec
const dircompare = require('dir-compare')

const runCommand = (cmd, dir, muteErrors, callback) => {
    callback(true)
    return //TODO temp

    const proc = exec(cmd, { cwd: dir })
    proc.stdout.on('data', data => console.log(data))
    if(!muteErrors) proc.stderr.on('data', data => console.error(data))
    proc.on('exit', code => callback(code === 0))
}

const reportSuccess = (message) => console.log('\x1b[33m%s\x1b[0m', message)

const reportNextStep = (message) => console.log('\x1b[36m%s\x1b[0m', message)

const reportError = (error) => {
    console.log('\x1b[31mERROR: %s\x1b[0m', error)
    process.exit(1)
}



function print(result) {
    console.log('Statistics - equal entries: %s, distinct entries: %s, left only entries: %s, right only entries: %s, differences: %s',
        result.equal, result.distinct, result.left, result.right, result.differences)
    result.diffSet.forEach(file => {
        if(file.state === 'left') console.log(`UPLOAD ${path.join(file.path1, file.name1)} TO ${path.join(file.relativePath, file.name1)}`)

    })
}




reportNextStep('Pulling changes...')
runCommand('git pull', './repo', false, gitResult => {
    if(gitResult) {
        reportNextStep('Installing dependencies...')
        runCommand('npm install', './repo', true, npmResult => {
            if(npmResult) {
                reportNextStep('Building Gatsby website...')
                runCommand('gatsby build', './repo', false, gatsbyResult => {
                    if(gatsbyResult) {
                        fs.mkdir('./currentFTP', { recursive: true }, (mkdirError) => {
                            if(!mkdirError) {
                                reportNextStep('Comparing build with previous data...')
                                const difference = dircompare.compareSync('./repo/public', './currentFTP', {
                                    compareSize: true,
                                    compareDate: true
                                })
                                if(!difference.same) {
                                    //TODO here
                                    print(difference)
                                }else{
                                    reportSuccess('Already up to date!')
                                }
                            }else{
                                reportError('mkdir currentFTP')
                            }
                        })
                    }else{
                        reportError('gatsby build')
                    }
                })
            }else{
                reportError('npm install')
            }
        })
    }else{
        reportError('git pull')
    }
})
