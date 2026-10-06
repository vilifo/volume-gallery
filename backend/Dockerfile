FROM python:3.12-slim AS builder

# Install build dependencies (PotreeConverter requires TBB)
RUN apt-get update && apt-get install -y \
    git \
    cmake \
    g++ \
    libtbb-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone and build the PotreeConverter executable
RUN git clone https://github.com/potree/PotreeConverter.git /opt/PotreeConverter \
    && cd /opt/PotreeConverter \
    && sed -i 's/__debugbreak();/\/\/ __debugbreak();/g' Converter/src/VBuffer.cpp Converter/src/indexer.cpp \
    && sed -i 's/state->name = js\["state"\]\["name"\];/state->name = js\["state"\]\["name"\].get<std::string>();/g' Converter/src/indexer.cpp \
    && sed -i 's/attribute.description = jsAttribute\["description"\];/attribute.description = jsAttribute\["description"\].get<std::string>();/g' Converter/src/indexer.cpp \
    && sed -i 's/chunk->id = jsChunk\["id"\];/chunk->id = jsChunk\["id"\].get<std::string>();/g' Converter/src/indexer.cpp \
    && sed -i 's/chunk->file = jsChunk\["file"\];/chunk->file = jsChunk\["file"\].get<std::string>();/g' Converter/src/indexer.cpp \
    && sed -i 's/__debugbreak();/\/\/ __debugbreak();/g' Converter/src/indexer.cpp \
    && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release .. \
    && make -j$(nproc)

RUN mkdir -p /opt/PotreeConverter/dist_libs && \
    find /opt/PotreeConverter/build -name "*.so*" -exec cp {} /opt/PotreeConverter/dist_libs/ \;
# Build from the repository root:
#   docker build -f backend/Dockerfile -t volume-gallery .
FROM python:3.12-slim

# Install system dependencies required for CMake and building Nexus
RUN apt-get update && apt-get install -y \
    wget \
    tar \
    ca-certificates \
    unzip \
    libtbb12 \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated directory for PotreeConverter
RUN mkdir -p /opt/potreeconverter

# Copy the executable AND the required resources folder
COPY --from=builder /opt/PotreeConverter/build/PotreeConverter /opt/potreeconverter/
COPY --from=builder /opt/PotreeConverter/resources /opt/potreeconverter/resources

# Create a wrapper script so argv[0] is always an absolute path
RUN echo '#!/bin/bash\nexec /opt/potreeconverter/PotreeConverter "$@"' > /usr/local/bin/PotreeConverter \
    && chmod +x /usr/local/bin/PotreeConverter
COPY --from=builder /opt/PotreeConverter/dist_libs/* /usr/local/lib/
RUN ldconfig

WORKDIR /opt

RUN ARCH=$(uname -m) && \
    wget "https://github.com/cnr-isti-vclab/nexus/releases/download/v2025.05/nexus-linux-${ARCH}.tar.gz" -O nexus_release.tar.gz \
    && mkdir -p /tmp/nexus \
    && tar -xzf nexus_release.tar.gz -C /tmp/nexus \
    && cp -rn /tmp/nexus/usr/* /usr/ \
    && ldconfig \
    && chmod +x /usr/bin/nxsbuild /usr/bin/nxscompress \
    && rm -rf nexus_release.tar.gz /tmp/nexus

# Create the vendor directories first
RUN mkdir -p /frontend/vendor/3dhop \
             /frontend/vendor/potree \
             /frontend/vendor/libs \
             /frontend/vendor/kiln-render/lib \
             /tmp/vendor_downloads

WORKDIR /tmp/vendor_downloads

# Download 3DHOP via master zip and extract the needed files from the minimal directory
RUN wget -q "https://github.com/cnr-isti-vclab/3DHOP/archive/refs/heads/master.zip" -O 3dhop.zip && \
    unzip -q 3dhop.zip && \
    cp 3DHOP-master/minimal/* /frontend/vendor/3dhop/ -r

# Download Potree dependencies
RUN wget -q "https://github.com/potree/potree/releases/download/1.8.2/Potree_1.8.2.zip" -O potree.zip && \
    unzip -q potree.zip && \
    cp -r Potree_1.8.2/build/potree/* /frontend/vendor/potree/ && \
    cp -r Potree_1.8.2/libs/* /frontend/vendor/libs/

# Download Kiln Render
RUN wget -q "https://cdn.jsdelivr.net/npm/kiln-render/lib/kiln-render.js" -O /frontend/vendor/kiln-render/lib/kiln-render.js

# Clean up
RUN rm -rf /tmp/vendor_downloads

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY frontend /frontend

ENV VG_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
