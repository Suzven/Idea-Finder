server {
    listen %ip%:%proxy_port%;
    server_name %domain_idn% %alias_idn%;

    error_log /var/log/%web_system%/domains/%domain%.error.log error;
    access_log /var/log/%web_system%/domains/%domain%.log combined;

    location ^~ /.well-known/acme-challenge/ {
        root %docroot%;
    }

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
