FROM node:20-bullseye

# Instalujemy Pythona i pip, żeby dashboard mógł uruchamiać też boty napisane w Pythonie
RUN apt-get update && apt-get install -y python3 python3-pip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    apt-get clean

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
