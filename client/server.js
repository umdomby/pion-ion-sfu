const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3000;
const buildPath = path.join(__dirname, 'build');

const server = http.createServer((req, res) => {
    const filePath = req.url === '/' ? 'index.html' : req.url;
    const fullPath = path.join(buildPath, filePath);

    fs.readFile(fullPath, (err, content) => {
        if (err) {
            // Fallback для SPA-роутинга
            fs.readFile(path.join(buildPath, 'index.html'), (err, content) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(content);
            });
        } else {
            const extname = path.extname(fullPath);
            let contentType = 'text/html';

            if (extname === '.js') contentType = 'text/javascript';
            else if (extname === '.css') contentType = 'text/css';
            else if (extname === '.json') contentType = 'application/json';

            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});