"use strict";

const fs_promises    = require("fs/promises")
     ,abort_signal   = AbortSignal.timeout(2 * 60 * 1000) //2 minutes timeout limit for file-read and spawn of ffprobe and ffmpeg.
     ,child_process  = require("child_process")
     ,options        = {encoding                 : "utf8"
                       ,signal                   : abort_signal
                       ,detached                 : false
                       ,shell                    : false
                       ,windowsVerbatimArguments : false
                       ,stdio                    : ["ignore", "pipe", "pipe"]
                       }
     ,path           = require("path")
     ,ffprobe_args   = ["-hide_banner"
                       ,"-err_detect"        , "ignore_err"
                       ,"-loglevel"          , "verbose"
                       ,"-strict"            , "experimental"
                       ,"-print_format"      , "json"
                       ,"-show_streams"
                       ,"-rw_timeout"        , String(1 * 60 * 1000 * 1000)  //1 minute (in micro-seconds) - time limit for ffprobe reading file I/O.
                       ,"-probesize"         , "2000M"
                       ,"-analyzeduration"   , "2000M"
                       //-i filename --- will be added for each file.
                       ]
     ,attachment_args = ["-hide_banner"
                       ,"-y"
                       ,"-err_detect"                   , "ignore_err"
                       ,"-loglevel"                     , "verbose"
                       ,"-strict"                       , "experimental"
                       ,"\"-dump_attachment:t:###ATTACHMENT_STREAM_INDEX###\""  ,  "\"###OUTPUT###\""
                       ,"-threads"                      , "2"
                       ,"-rw_timeout"                   , String(1 * 60 * 1000 * 1000)  //1 minute (in micro-seconds) - time limit for ffprobe reading file I/O.
                       ,"-probesize"                    , "2000M"
                       ,"-analyzeduration"              , "2000M"
                       ,"-thread_queue_size"            , "16384"
                       ,"-i"                            , "\"file:" + "###INPUT###" + "\""
                       ]
     ,ffmpeg_args    = ["-hide_banner"
                       ,"-y"
                       ,"-err_detect"                   , "ignore_err"
                       ,"-loglevel"                     , "verbose"
                       ,"-strict"                       , "experimental"
                       ,"-threads"                      , "2"
                       ,"-rw_timeout"                   , String(1 * 60 * 1000 * 1000)  //1 minute (in micro-seconds) - time limit for ffprobe reading file I/O.
                       ,"-probesize"                    , "2000M"
                       ,"-analyzeduration"              , "2000M"
                       ,"-thread_queue_size"            , "16384"
                       ,"-i"                            , "\"file:" + "###INPUT###" + "\""
                       ,"-map"                          , "0:" + "###GLOBAL_STREAM_INDEX###"
                       ,"-c"                            , "copy"
                       ,"-threads"                      , "2"
                       ,"-flags"                        , "\"+cgop+loop-unaligned-output_corrupt\""
                       ,"-fflags"                       , "\"+genpts+autobsf+discardcorrupt+igndts+ignidx\""
                       ,"-avoid_negative_ts"            , "make_zero"
                       ,"-use_wallclock_as_timestamps"  , "1"
                       ,"-max_muxing_queue_size"        , "9999"
                       ,"-bufsize"                      , "8M"
                       ,"-movflags"                     , "\"+faststart\""
                     //,"-f"                            , "###CODEC_NAME###" 
                       ,"\"###OUTPUT###\""
                       ]
      ;

const spawn = async (cmd, args)=>{
  return new Promise((resolve, reject) => {
    let stdout      = []
       ,stderr      = []
       ;
    const process   = child_process.spawn(cmd, args, options);
    process.stdout.on("data", s=>{stdout.push(s);});
    process.stderr.on("data", s=>{stderr.push(s);});
    process.on("close", (exit_code, signal)=>{
      const pipes = {"stdout":stdout.join(""),"stderr":stderr.join("")};
      if(0 === exit_code){
        resolve(pipes);
      }else{
        const err = new Error("process finished with exit code of:" + exit_code + " (not zero)");
        err.pipes = pipes; //piggyback err object with additional data, but still preserve promise behaviour.
        reject(err);
      }
    });
  });
};


//resolve path of a file, normalizing it to linux forward-slash.
const resolve_path = async (file)=>{
  file = file.replace(/[\/\\]+/gm, "/");
  file = path.resolve(file);
  file = file.replace(/[\/\\]+/gm, "/");
  file = await fs_promises.realpath(file, {encoding:"utf8"});
  file = file.replace(/[\/\\]+/gm, "/");
  return file;
};


const resolve_paths = async (files)=>{
  files = (await Promise.allSettled(files.map(file=>resolve_path(file))))
          .filter(settled_result=>("fulfilled" === settled_result.status))
          .map(settled_result=>settled_result.value)
  return files;
};


const file_ffprobe = async (file)=>{
  const result   = await spawn("ffprobe.exe", ffprobe_args.concat("-i", file))
       ,json_str = result.stdout
       ,json_obj = JSON.parse(json_str)
       ;
  return json_obj;
};


const files_ffprobe = async (files)=>{
  return (await Promise.allSettled(files.map(file=>file_ffprobe(file))))
         .map((settled_result,index)=>{
                  return {"file"   : files[index]
                         ,"status" : settled_result.status
                         ,"value"  : settled_result.value || {}
                         }
         })
         .filter(o=>("fulfilled" === o.status))
         ;
};


const file_dump = async (file_and_ffprobe_obj)=>{ //for a single {file, ffprobe object} it creates a base folder for the streams and write the JSON to file in it.
  const file         = file_and_ffprobe_obj.file
       ,ffprobe_obj  = file_and_ffprobe_obj.value
       ,parts        = path.parse(file)
       ,dump_dir     = parts.dir + "/" + "__dump_" + parts.name
       ,json_file    = dump_dir + "/" + parts.name + ".json"
       ,json_str     = JSON.stringify(ffprobe_obj, null, 2)
                           .replace(/,[\r\n] /g, "\r\n ,")
                           .replace(/ *(,( +))/g,"$2,")
       ,dump_file         = dump_dir + "/" + "dump.cmd"          //does not need to be unique since it sits inside its own folder.
       ,dump_file_content = []
       ;
  dump_file_content.push("::@echo off");
  dump_file_content.push("chcp 65001 1>nul 2>nul");
  dump_file_content.push("pushd \"%~dp0\"");
  dump_file_content.push("");

  await fs_promises.mkdir(dump_dir, {recursive:true});
  await fs_promises.writeFile(json_file, json_str, options);

  let attachment_index = 0; //attachment dumping uses a different syntax which specify the stream type, and relative index of total attachments.

  ffprobe_obj.streams.forEach(stream=>{
    dump_file_content.push("::-------------------------- stream [" + String(stream.index+1).padStart(3,"0") + "/" + String(ffprobe_obj.streams.length).padStart(3,"0") + "] - " + stream.codec_type.padEnd(10," ") + (stream.tags.language ? " - " + stream.tags.language : "") + (stream.tags.title ? " - " + stream.tags.title : "") );

    let output = stream.tags.filename;
    output = output || stream.codec_type + "_" + (stream.tags.language || "") + "_" + (stream.tags.title || "") + "." + ("video" === stream.codec_type ? "mkv" : stream.codec_name);
    output = output.trim().toLowerCase();
    output = output.replace(/['"\s\(\)\[\]\/\\]+/igm, "_").replace(/_+/igm, "_").replace(/_+\./igm,".");
    output = (String(stream.index)).padStart(3,"0") + "_" + output;

    dump_file_content.push("::--- " + output);


    let cmd = "";    
    if("attachment" === stream.codec_type){ //ffmpeg has built-in attachment dump, which specify the output file right after the dump command and the actual input file is at the end. the index is relative to total amount of attachments using the stream selection 't'.  it is also possible to use the tag.filename with ffmpeg -dump_attachment:t "" -i INPUT  ---- see: https://ffmpeg.org/ffmpeg.html
      cmd = attachment_args.join(" ").replace("###ATTACHMENT_STREAM_INDEX###", attachment_index);
      attachment_index = attachment_index + 1;
    }else{
      cmd = ffmpeg_args.join(" ").replace("###GLOBAL_STREAM_INDEX###", stream.index);
    }
    cmd = cmd.replace("###INPUT###", file)
             .replace("###OUTPUT###", output)
             ;
    cmd = "\"ffmpeg.exe\"" + "  " + cmd;

    dump_file_content.push(cmd);
    dump_file_content.push("::----------------------------------------------------------------------");
    dump_file_content.push("");
  });
  await fs_promises.writeFile(dump_file, dump_file_content.join("\r\n"), options);
};


const files_dump = async (file_and_ffprobe_obj_arr)=>{
  await Promise.allSettled(file_and_ffprobe_obj_arr.map(file_and_ffprobe_obj=>file_dump(file_and_ffprobe_obj)));
};


queueMicrotask(async ()=>{
  let files = process.argv.slice(2);
  files = await resolve_paths(files);
  
  let file_and_ffprobe_obj_arr = await files_ffprobe(files);
  await files_dump(file_and_ffprobe_obj_arr);

  process.exitCode = 0;
  process.exit();
});







/*
const dump_writter = async (file)=>{ //parse json to object, loop streams, create a dump script for each stream.

  const parts     = require("path").parse(file)
       ,json_file = parts.dir + "/" + parts.name + "__ffprobe.json"
       ,json_str  = await fs_promises.readFile(json_file, options)
       ,json_obj  = JSON.parse(json_str)
       ;

  json_obj.streams.forEach(stream=>{
    const folder   = stream.codec_type
         ,index    = String(stream.index || "0").padStart(3,"0")
         ,language = (stream.tags || {"language":""}).language || "en"
         ,filename = (stream.tags || {"filename":""}).filename
         ,ext      = stream.codec_name || "dat"
         ,output   = folder + "/" + "__index_"    + index
                                  + "__language_" + langauge
                                  + ("" === filename ? "." + ext : filename)
         ;
    console.error("[INFO] output file: \r\n" + output);
  });
};
*/



void 0;