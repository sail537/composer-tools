/* 用 sips 生成的各尺寸 PNG 组装 ICNS（不依赖 iconutil 的严格校验）。
   用法：
     node make-icns.mjs <iconset目录> <输出.icns>
   目录里需有 icon_16x16.png / @2x / 32 / 32@2x / 128 / 128@2x / 256 / 256@2x / 512 / 512@2x。
*/
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const out = process.argv[3];
if (!dir || !out) {
  console.error('usage: node make-icns.mjs <iconset-dir> <out.icns>');
  process.exit(2);
}

// 现代 macOS 支持 PNG 数据的这些类型
const map = [
  ['ic11', 'icon_16x16@2x.png'],   // 32
  ['ic12', 'icon_32x32@2x.png'],   // 64
  ['ic07', 'icon_128x128.png'],    // 128
  ['ic13', 'icon_128x128@2x.png'], // 256
  ['ic08', 'icon_256x256.png'],    // 256
  ['ic14', 'icon_256x256@2x.png'], // 512
  ['ic09', 'icon_512x512.png'],    // 512
  ['ic10', 'icon_512x512@2x.png']  // 1024
];

const chunks = [];
for (const [type, name] of map) {
  const file = path.join(dir, name);
  const data = fs.readFileSync(file);
  if (data.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(name + ' 不是 PNG');
  }
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, 'ascii');
  head.writeUInt32BE(8 + data.length, 4);
  chunks.push(head, data);
}
const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(8 + body.length, 4);
fs.writeFileSync(out, Buffer.concat([header, body]));
console.log('written', out, fs.statSync(out).size, 'bytes');
