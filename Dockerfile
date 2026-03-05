# Base image Node.js (nhẹ, ổn định cho Cloud Run)

FROM node:20-slim

# Cài ffmpeg và các lib cần thiết

RUN apt-get update && 
apt-get install -y --no-install-recommends 
ffmpeg 
ca-certificates 
curl 
&& rm -rf /var/lib/apt/lists/*

# Thư mục làm việc

WORKDIR /app

# Copy package trước để cache layer npm install

COPY package*.json ./

# Cài dependencies

RUN npm install --omit=dev

# Copy toàn bộ source

COPY . .

# Cloud Run dùng PORT env

ENV PORT=8080

# Expose port

EXPOSE 8080

# Start server

CMD ["npm","start"]
