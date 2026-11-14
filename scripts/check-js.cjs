const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
let checked=0;
function walk(folder){
  for(const item of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,item.name);
    if(item.isDirectory())walk(file);
    else if(/\.(?:js|cjs)$/.test(item.name)){
      const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit',windowsHide:true});
      if(result.error)throw result.error;
      if(result.status!==0)process.exit(result.status||1);
      checked++;
    }
  }
}
for(const folder of ['web','tests','scripts'])walk(folder);
console.log('JavaScript syntax checked:',checked,'files');
