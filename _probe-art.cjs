const fs=require('fs');
const L=fs.readFileSync('lib/rpa.mjs','utf8').replace(/\r\n/g,'\n').split('\n');
for(let i=1655;i<1735;i++){ if(L[i]) console.log((i+1)+': '+L[i].slice(0,175)); }
