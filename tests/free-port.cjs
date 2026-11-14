// The suite always creates a new offline server; never probe a fixed user application port.
const net=require('node:net');
module.exports=()=>new Promise((resolve,reject)=>{
  const server=net.createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});
});
