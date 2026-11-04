FROM alpine:3
RUN apk add --no-cache python3 git openssh-client \
 && mkdir -p /root/.ssh \
 && printf 'Host github.com\n  StrictHostKeyChecking accept-new\n  IdentityFile /root/.ssh/id_ed25519\n' > /root/.ssh/config
COPY sync.py /sync.py
CMD ["python3", "-u", "/sync.py"]
