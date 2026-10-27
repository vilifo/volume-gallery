FROM python:3.12-slim AS builder

# Install build dependencies (PotreeConverter requires TBB)
RUN apt-get update && apt-get install -y \
    git \
    cmake \
    g++ \
    libtbb-dev \
    && rm -rf /var/lib/apt/lists/*

# Clone and build the PotreeConverter executable, at a fixed commit (tag 2.1.5) instead of whatever
# master is on the day of the build. The sed patches below target this source: when bumping the commit,
# check that they still match.
ARG POTREE_CONVERTER_REF=c2cb61843bf2b901e8e257874b1a6dcf67792fb2
RUN git clone https://github.com/potree/PotreeConverter.git /opt/PotreeConverter \
    && cd /opt/PotreeConverter \
    && git checkout --quiet ${POTREE_CONVERTER_REF} \
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

# kiln-render: built from the v0.5.0 GitHub tag + our patch (backend/kiln-patches).
# Its own stage so it is cached independently and never depends on what happens to
# be in frontend/vendor. The patches lift the 10-slots-per-axis atlas cap, add finer LOD
# levels and make the camera rotate freely (no poles, with roll).
FROM oven/bun:1-debian AS kiln
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git wget unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /kiln
# The download is checked against a SHA-256 (a changed archive fails the build); update it with the tag.
ARG KILN_RENDER_SHA256=5e2fa62437ca063d980354c88817faacc28b2251641a3da72f26fd31d2ec6040
RUN wget -q "https://github.com/MPanknin/kiln-render/archive/refs/tags/v0.5.0.zip" -O kiln-render.zip \
    && echo "${KILN_RENDER_SHA256}  kiln-render.zip" | sha256sum -c - \
    && unzip -q kiln-render.zip \
    && mv kiln-render-0.5.0/* kiln-render-0.5.0/.[!.]* . 2>/dev/null || true \
    && rm -rf kiln-render-0.5.0 kiln-render.zip \
    && bun install --frozen-lockfile \
    && bun run build:lib
COPY backend/kiln-patches /tmp/kiln-patches
RUN sed -i 's/\r$//' /tmp/kiln-patches/*.patch \
    && git apply --ignore-whitespace /tmp/kiln-patches/*.patch \
    && grep -q "MAX_GRID_SIZE = 32" lib/kiln-render.js \
    && grep -q "getFullOrbitState" lib/kiln-render.js \
    && grep -q 'hSign = this.upAxis.startsWith("-") ? 1 : -1' lib/kiln-render.js

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

# Download 3DHOP at a fixed commit (tag 4.3), checked against a SHA-256, and extract the needed files
# from the minimal directory
ARG THREEDHOP_REF=a8c145ddc575df5291e073a377d942ff77c34901
ARG THREEDHOP_SHA256=cd0fed714ce0f86164e81a4d868c5689f7a2dd8de2908d01e07eb82927309147
RUN wget -q "https://github.com/cnr-isti-vclab/3DHOP/archive/${THREEDHOP_REF}.zip" -O 3dhop.zip && \
    echo "${THREEDHOP_SHA256}  3dhop.zip" | sha256sum -c - && \
    unzip -q 3dhop.zip && \
    cp 3DHOP-${THREEDHOP_REF}/minimal/* /frontend/vendor/3dhop/ -r

# Download Potree dependencies
ARG POTREE_SHA256=c140a8bce0ce129de762fbc0fd3ba7c21120ffd36d423dd2755abb39f32aebe5
RUN wget -q "https://github.com/potree/potree/releases/download/1.8.2/Potree_1.8.2.zip" -O potree.zip && \
    echo "${POTREE_SHA256}  potree.zip" | sha256sum -c - && \
    unzip -q potree.zip && \
    cp -r Potree_1.8.2/build/potree/* /frontend/vendor/potree/ && \
    cp -r Potree_1.8.2/libs/* /frontend/vendor/libs/

# Clean up
RUN rm -rf /tmp/vendor_downloads

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY frontend /frontend
# Default branding (branding.toml + logo); docker-compose mounts ./branding over it.
COPY branding /branding

# Patched kiln-render from the `kiln` stage. Copied after `COPY frontend` so it
# always wins over any frontend/vendor/kiln-render copy in the build context.
COPY --from=kiln /kiln/lib/kiln-render.js /frontend/vendor/kiln-render/lib/kiln-render.js

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
