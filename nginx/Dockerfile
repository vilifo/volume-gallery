FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template

# Makes the workers run as the app's uid:gid (VG_UID / VG_GID), see the script. The image's
# entrypoint runs everything in /docker-entrypoint.d in name order, as root, before nginx starts.
# (sed: a checkout with Windows line endings must not break the shebang line.)
COPY docker-entrypoint.d/05-worker-user.sh /docker-entrypoint.d/05-worker-user.sh
RUN sed -i 's/\r$//' /docker-entrypoint.d/05-worker-user.sh && chmod +x /docker-entrypoint.d/05-worker-user.sh
