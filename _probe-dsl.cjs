const fs=require('fs');
const t=fs.readFileSync('lib/rpa/dsls/taobao/tb_traffic_source_excel.json','utf8');
const j=JSON.parse(t);
console.log(JSON.stringify(j.template.steps.map(s=>({id:s.id,action:s.action,target:s.target,outputKey:s.outputKey,timeoutMs:s.timeoutMs,onError:s.onError}))).slice(0,1500));
console.log('--- collection', JSON.stringify(j.collection));
