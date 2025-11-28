# Android APK Builder for ARM64 (Radxa)
# Builds Datasetto Android app using Capacitor + Gradle
#
# Usage:
#   docker compose -f docker-compose.builder.yml up --build

FROM node:20-bookworm

# Install Android SDK dependencies
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Java home
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
ENV PATH=$PATH:$JAVA_HOME/bin

# Android SDK setup
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=$ANDROID_HOME
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

# Download and install Android command-line tools
RUN mkdir -p $ANDROID_HOME/cmdline-tools && \
    cd $ANDROID_HOME/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip && \
    unzip -q tools.zip && \
    rm tools.zip && \
    mv cmdline-tools latest

# Accept licenses and install required SDK components
RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true && \
    sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# Create app directory
WORKDIR /build

# Copy package files first for better caching
COPY client/package*.json ./client/
COPY mobile/package*.json ./mobile/

# Install client dependencies
WORKDIR /build/client
RUN npm ci --legacy-peer-deps

# Install mobile dependencies
WORKDIR /build/mobile
RUN npm ci

# Copy source code
WORKDIR /build
COPY client ./client
COPY mobile ./mobile

# Build client for mobile
WORKDIR /build/client
ENV VITE_BUILD_TARGET=mobile
RUN npm run build

# Copy built client to mobile www folder
WORKDIR /build/mobile
RUN mkdir -p www && cp -r ../client/dist/* www/

# Add Android platform if not exists, then sync
# The android folder from the repo should be copied, but cap sync will update it
RUN npx cap add android 2>/dev/null || true && npx cap sync android

# Build APK
WORKDIR /build/mobile/android
RUN chmod +x gradlew && \
    ./gradlew assembleRelease --no-daemon

# Copy APK to output
RUN mkdir -p /build/mobile/release && \
    cp app/build/outputs/apk/release/*.apk /build/mobile/release/ 2>/dev/null || \
    cp app/build/outputs/apk/debug/*.apk /build/mobile/release/ 2>/dev/null || true

WORKDIR /build/mobile

# Default command just lists the built APKs
CMD ["sh", "-c", "ls -la release/ && echo 'APK build complete!'"]
