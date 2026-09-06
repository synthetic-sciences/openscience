FROM --platform=linux/amd64 docker.io/library/python@sha256:2fe5997d249a808b8eeea52c58a1dbffbba28754dc11699ef5c029f2d818ce79

RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils curl git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/harbor-native-fixture
COPY fixture-input.json ./
COPY provider.py entrypoint.sh /opt/native-fixture/
ENTRYPOINT ["bash", "/opt/native-fixture/entrypoint.sh"]
CMD ["sleep", "infinity"]
