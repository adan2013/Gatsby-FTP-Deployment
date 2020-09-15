# Gatsby-FTP-Deployment

This script allows you to automatically build your Gatsby website and upload it to the FTP server. By using a differential copy, only the files that have changed are sent to the server on the next deployment. Thanks to this, the deployment is quick and does not unnecessarily strain the server.

Script was created for the purposes of automatically building the [redark.pl](https://redark.pl) website.

## Instalation

1. Clone this repository to your computer
    ```
    git clone https://github.com/adan2013/Gatsby-FTP-Deployment.git
    ```
2. Install dependencies:
    ```
    npm install
    ```
3. Add the required `.env` file in the main directory of this repository (more information below)
4. Clone repository with your Gatsby website into `repo` directory:
    ```
    git clone URL_TO_YOUR_REPOSITORY ./repo
    ```
5. Switch cloned repository to the appropriate branch from which you want to download changes:
    `````
    cd repo
    git checkout BRANCH_NAME
    cd ..
    `````
6. Make sure you have `gatsby-cli` globally installed on your computer before running the script. If not, use this command:
    ```
    npm install -g gatsby-cli
    ```
7. Run the script:
    ```
    node index.js
    --- or ---
    npm run deploy
    ```

## Actions

The script performs the following actions:

1. Pulling changes from git repository
2. Installing NPM dependencies
3. Building Gatsby production version
4. Comparing current files with previous build
5. Uploading ONLY modified files and directories to FTP server
6. Saving uploaded files on local computer to optimalize deploying next build
7. Sending an e-mail with a script running report

## Differential copy

After the file transfer is complete, the script will copy the current data into the `currentFTP` directory. As a result, the next time you run the script, only the files that have changed will be sent to the FTP server. If you want to upload all files to the server, please delete the `currentFTP` directory!

## Configuration file

Script required an `.env` file with the FTP and SMTP server configuration:

* FTP_HOST - address of your FTP server
* FTP_USER - ftp account login
* FTP_PASSWORD - ftp account password
* MAIL_HOST - address of your mail server
* MAIL_PORT - port number (465 for SMTP protocol)
* MAIL_SECURE - use secure connection (type "true" for use FTPS over TLS)
* MAIL_USER - mail account login
* MAIL_PASSWORD - mail account password
* MAIL_DESTINATION_ADDRESS - destination e-mail address for sending deployment logs

### Example:
```
FTP_HOST=ftp.mywebsite.com
FTP_USER=ftp_www_mywebsite
FTP_PASSWORD=ftpP@$$word
MAIL_HOST=webmail.mywebsite.com
MAIL_PORT=465
MAIL_SECURE=true
MAIL_USER=contact@mywebsite.com
MAIL_PASSWORD=mailP@$$word
MAIL_DESTINATION_ADDRESS=admin@mywebsite.com
```
