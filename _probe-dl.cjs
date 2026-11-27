const fs=require('fs');
const L=fs.readFileSync('lib/rpa.mjs','utf8').replace(/\r\n/g,'\n').split('\n');
const pat="o.op === 'download'";
let s=-1;
for(let i=0;i<L.length;i++){ if(L[i].includes(pat)){ s=i; break; } }
console.log('start', s+1);
for(let i=s;i<Math.min(L.length, s+95); i++){ console.log((i+1)+': '+L[i].slice(0,170)); }
