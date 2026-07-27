import http from "http"; import fs from "fs"; import path from "path";
const root=path.resolve(process.argv[2]||"public"); const port=+(process.argv[3]||8787);
const types={".html":"text/html",".json":"application/json",".js":"text/javascript",".css":"text/css"};
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split("?")[0]); if(p==="/")p="/index.html";
  const fp=path.join(root,p);
  fs.readFile(fp,(e,buf)=>{ if(e){res.writeHead(404);res.end("404");return;}
    res.writeHead(200,{"content-type":(types[path.extname(fp)]||"application/octet-stream")+"; charset=utf-8"}); res.end(buf); });
}).listen(port,()=>console.log("serving",root,"on",port));
