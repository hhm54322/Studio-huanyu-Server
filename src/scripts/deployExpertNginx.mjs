import {readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs'
// Invoked on the host after the independent workbench build has been staged.
const file='/etc/nginx/sites-available/huanyu-web'
const original=readFileSync(file,'utf8')
const marker='    # Huanyu formal expert workbench'
if(original.includes(marker)){console.log('Expert Nginx routes already configured');process.exit(0)}
const anchor='    location = /expert-review-preview {'
if(!original.includes(anchor))throw Error('Expected site anchor absent; refusing to guess Nginx placement')
const block=`    # Huanyu formal expert workbench
    location = /expert-review { return 302 /expert-review/; }
    location ^~ /expert-review/ {
        alias /var/www/huanyu-expert-review/;
        index index.html;
        autoindex off;
        add_header Cache-Control "private, no-store, no-cache, max-age=0" always;
        add_header X-Robots-Tag "noindex, nofollow, nosnippet" always;
        add_header X-Content-Type-Options nosniff always;
        limit_except GET { deny all; }
    }
    location ^~ /api/expert/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
        client_max_body_size 2m;
        proxy_cache off;
        proxy_no_cache 1;
        proxy_cache_bypass 1;
        add_header Cache-Control "private, no-store, no-cache, max-age=0" always;
        add_header Vary "Cookie" always;
        add_header X-Robots-Tag "noindex, nofollow, nosnippet" always;
    }

`
const backup='/etc/nginx/sites-available/huanyu-web.before-expert-20261014'
if(!existsSync(backup))copyFileSync(file,backup)
writeFileSync(file,original.replace(anchor,block+anchor))
console.log('Nginx expert routes added; run nginx -t before reload')
