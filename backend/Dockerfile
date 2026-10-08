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

RUN apt-get update && apt-get install -y --no-install-recommends \
    qtbase5-dev \
    && rm -rf /var/lib/apt/lists/*
COPY backend/nexus-patches /tmp/nexus-patches
RUN git clone --depth 1 --branch 2025.07 https://github.com/cnr-isti-vclab/vcglib.git /opt/vcglib \
    && git clone --depth 1 --branch v2025.05 --recurse-submodules --shallow-submodules \
       https://github.com/cnr-isti-vclab/nexus.git /opt/nexus-src \
    && cd /opt/nexus-src \
    && git apply --ignore-whitespace /tmp/nexus-patches/*.patch \
    && cmake -S . -B build -DVCGDIR=/opt/vcglib -DBUILD_NXS_VIEW=OFF -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target nxsbuild nxscompress -j"$(nproc)" \
    && mkdir -p /opt/nexus/bin /opt/nexus/lib \
    && cp build/src/nxsbuild/nxsbuild build/src/nxsedit/nxscompress /opt/nexus/bin/ \
    && ldd /opt/nexus/bin/nxsbuild /opt/nexus/bin/nxscompress | awk '/=> \//{print $3}' \
       | grep -v -E '/lib(c|m)\.so' | sort -u | xargs -I{} cp -L {} /opt/nexus/lib/

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Install system dependencies required for CMake and building Nexus
RUN apt-get update && apt-get install -y \
    wget \
    tar \
    ca-certificates \
    unzip \
    libtbb12 \
    libgl1 \
    unzip \
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

# Nexus tools built in the builder stage (see there); their Qt/ICU/... libraries live in
# /opt/nexus/lib so they cannot clash with anything else in the image.
COPY --from=builder /opt/nexus/bin/ /usr/local/bin/
COPY --from=builder /opt/nexus/lib/ /opt/nexus/lib/
RUN echo /opt/nexus/lib > /etc/ld.so.conf.d/nexus.conf && ldconfig \
    && ldd /usr/local/bin/nxsbuild /usr/local/bin/nxscompress | (! grep "not found")

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

# /processing is the mount point for the optional scratch directory (set
# VG_PROCESSING_DIR=/processing to use it, see the README). No VOLUME for it:
# when nothing is mounted there, an anonymous volume would just pile up.
RUN mkdir -p /data /processing

ENV VG_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8000

# The static frontend at / needs no login, so a 200 there means uvicorn is up and serving.
# nginx waits for this (see docker-compose.yml) instead of starting while the app boots;
# the first probe runs one interval after start, hence the short interval.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/', timeout=4)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
