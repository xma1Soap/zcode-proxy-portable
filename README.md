# glm-proxy-coexist

Independent branch of https://github.com/xma1Soap/zcode-proxy-portable  
Does not replace the `main` portable exe.

MIT. Based on [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api).

## npm remote install

```bash
# global
npm install -g github:xma1Soap/zcode-proxy-portable#glm-proxy
glm-proxy start
glm-proxy start 8082
glm-proxy start --port 9000
glm-proxy list
glm-proxy stop 8082
glm-proxy stop --all
```

```bash
# one-shot, no global install
npx --yes github:xma1Soap/zcode-proxy-portable#glm-proxy start 8081
```

```bash
# inside a project
npm install github:xma1Soap/zcode-proxy-portable#glm-proxy
npx glm-proxy start 8082
```

First `start` downloads the Linux prebuild from release `v1` into `~/.glm-proxy-coexist/`.  
WebUI: `http://127.0.0.1:<port>/webui`

```bash
# pnpm / yarn
pnpm add github:xma1Soap/zcode-proxy-portable#glm-proxy
yarn add github:xma1Soap/zcode-proxy-portable#glm-proxy
```

## From source (this branch)

Needs [Bun](https://bun.sh).

```bash
git clone -b glm-proxy https://github.com/xma1Soap/zcode-proxy-portable.git
cd zcode-proxy-portable
bun install
bash start.sh 8081
```
