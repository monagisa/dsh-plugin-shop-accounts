const fs=require('fs');
const j=JSON.parse(fs.readFileSync('lib/rpa/dsls/douyin/douyin_shop_transaction.json','utf8'));
for (const s of j.template.steps) console.log(JSON.stringify({id:s.id,action:s.action,target:s.target,outputKey:s.outputKey,timeoutMs:s.timeoutMs,onError:s.onError,saveName:s.saveName}).slice(0,300));
console.log('--- collection', JSON.stringify(j.collection));
