# Build from the repository root:
#   docker build -f backend/Dockerfile -t volume-gallery .
FROM python:3.12-slim

# Install system dependencies required for CMake and building Nexus
RUN apt-get update && apt-get install -y \
    git \
    cmake \
    g++ \
    build-essential \
    zlib1g-dev \
    liblz4-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone and compile the Nexus C++ libraries and tools
WORKDIR /opt
RUN git clone https://github.com/cnr-isti-vclab/nexus.git
WORKDIR /opt/nexus/build
RUN cmake .. && make -j$(nproc)

# Make the Nexus executables globally accessible
RUN cp nxsbuild nxcompress /usr/local/bin/

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY frontend /frontend

ENV VG_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
