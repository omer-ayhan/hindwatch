# Records docs/demo.gif from a generic app root (/tmp/my-app) so the GIF matches the
# README quickstart (commands with no --root). Fixture plugins + crash JSONL are staged
# into that folder; no device or Metro needed.
# Install vhs:  brew install vhs
# Record:       vhs docs/demo.tape   (from the repo root, after npm install)

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1400
Set Height 800
Set TypingSpeed 40ms
Set Padding 20

Hide
Type `export HINDWATCH_CLIENT=demo REPO="$PWD" PATH="$PWD/node_modules/.bin:$PATH" PS1='my-app $ '`
Enter
Type `hindwatch() { tsx "$REPO/packages/core/src/cli.ts" "$@"; }`
Enter
Type `node -e 'const fs=require("fs");const p=require("path");const repo=process.env.REPO;fs.rmSync("/tmp/my-app",{recursive:true,force:true});fs.mkdirSync("/tmp/my-app");fs.copyFileSync(p.join(repo,"fixtures/forced-crash.jsonl"),"/tmp/my-app/forced-crash.jsonl");fs.writeFileSync("/tmp/my-app/hindwatch.config.json",JSON.stringify({plugins:[{module:repo+"/packages/plugin-fixture/src/index.ts",options:{file:"forced-crash.jsonl",clockSkewMs:{"android-a":0}}},{module:repo+"/examples/crash-detector/index.js"}]},null,2))'`
Enter
Type `hindwatch stop >/dev/null 2>&1 || true; cd /tmp/my-app; clear`
Enter
Show

Type "hindwatch start"
Enter
Sleep 4s

Type "hindwatch mark after-crash"
Enter
Sleep 2s

Type "hindwatch incidents"
Enter
Sleep 3s

Type "hindwatch incident 1 --part stack --budget 600"
Enter
Sleep 4s

Type "hindwatch expect --absent TypeError --since after-crash"
Enter
Sleep 3s

Type "hindwatch stop"
Enter
Sleep 2s
