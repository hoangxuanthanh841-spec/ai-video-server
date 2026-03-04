import express from "express"
import ffmpeg from "fluent-ffmpeg"
import fs from "fs"
import path from "path"
import axios from "axios"

const app = express()
app.use(express.json())

app.get("/health", (req,res)=>{
  res.send("OK")
})

app.post("/v1/video/concatenate", async (req,res)=>{
  const { videos } = req.body

  const files = []

  for (let i=0;i<videos.length;i++){
    const response = await axios.get(videos[i],{responseType:"stream"})
    const file = `/tmp/video${i}.mp4`
    const writer = fs.createWriteStream(file)
    response.data.pipe(writer)

    await new Promise(r=>writer.on("finish",r))
    files.push(file)
  }

  const listFile = "/tmp/list.txt"
  fs.writeFileSync(listFile, files.map(f=>`file '${f}'`).join("\n"))

  const output = "/tmp/output.mp4"

  await new Promise((resolve,reject)=>{
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat","-safe 0"])
      .outputOptions(["-c copy"])
      .save(output)
      .on("end",resolve)
      .on("error",reject)
  })

  res.json({
    success:true,
    file:output
  })
})

app.listen(8080)