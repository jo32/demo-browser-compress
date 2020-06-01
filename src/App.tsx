import React, { Component, useState } from 'react';
import './App.css';

import { readFileAsArrayBuffer, WorkerProxy, defaultTaskOpts } from "./lib";

/* eslint import/no-webpack-loader-syntax: off */
// import PlainWorker from "worker-loader!./plain.worker";
import CompressWorker from "worker-loader!./compress.worker";
import DecompressWorker from "worker-loader!./decompress.worker";

// prevent default opening files
window.addEventListener("dragover", function (e) {
  e.preventDefault();
}, false);
window.addEventListener("drop", function (e) {
  e.preventDefault();
}, false);

interface AppProps { }
interface AppState {
  name: string;
}

interface DropZoneProps {
  type: string
}

interface ProgressBarProps {
  progress: number
}

function ProgressBar(props: React.PropsWithChildren<ProgressBarProps>) {

  return <progress className="progress-bar" value={ props.progress } max="100"></progress>
}

function DropZone(props: React.PropsWithChildren<DropZoneProps>) {
  let [isHover, setIsHover] = useState(false);
  let [readingFile, setReadingFile] = useState(false);
  let [progress, setProgress] = useState(0);

  function onDragEnter(evt: React.DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    setIsHover(true);
  }

  function onDragExit(evt: React.DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    setIsHover(false);
  }

  function saveBlobAsFile(fileName: string, blob: Blob) {
    let downloadLink = document.createElement("a");
    downloadLink.download = fileName;
    downloadLink.href = window.URL.createObjectURL(blob);
    downloadLink.onclick = function(event) {
      document.body.removeChild(event.target as Node);
    }
    downloadLink.style.display = "none";
    document.body.appendChild(downloadLink);
    downloadLink.click();
  }

  async function transformFile(file: File) {
    let ab = await readFileAsArrayBuffer(file);
    console.log("file transform:", props.type);
    let w =
      props.type == "compress" ? new CompressWorker() : new DecompressWorker();
    let wp = new WorkerProxy(w, defaultTaskOpts, ab);
    wp.initWorker();
    wp.onProgress((progress) => {
      setProgress(progress == 100 ? 0 : progress);
    });
    let resp = await wp.done();
    let blob = new Blob(resp, {
      type: `application/octet-stream`
    });
    console.log(resp, file.type);
    saveBlobAsFile(props.type == "compress" ? `${file.name}.compress` : file.name.replace(".compress", ""), blob);
  }

  async function onDrop(evt: React.DragEvent) {
    evt.preventDefault();
    evt.stopPropagation();
    setIsHover(false);

    if (readingFile) {
      return;
    }

    if (evt.dataTransfer.items) {
      // Use DataTransferItemList interface to access the file(s)
      for (let i = 0; i < evt.dataTransfer.items.length; i++) {
        // If dropped items aren't files, reject them
        if (evt.dataTransfer.items[i].kind === 'file') {
          let file = evt.dataTransfer.items[i].getAsFile();
          if (file === null) {
            let msg = "File Null!";
            window.alert(msg);
            throw new Error(msg);
          }
          console.log('... file[' + i + '].name = ' + file.name);
          setReadingFile(true);
          await transformFile(file);
          setReadingFile(false);
          break;
        }
      }
    } else {
      // Use DataTransfer interface to access the file(s)
      for (let i = 0; i < evt.dataTransfer.files.length; i++) {
        console.log('... file[' + i + '].name = ' + evt.dataTransfer.files[i].name);
        setReadingFile(true);
        transformFile(evt.dataTransfer.files[i]);
        setReadingFile(false);
        break;
      }
    }
  }

  return <div
    className={`drop-zone flex-item flex-container${isHover ? " hover" : ""}${readingFile ? " reading" : ""}`}
    onDrop={onDrop}
    onDragEnter={onDragEnter}
    onDragExit={onDragExit}
    onDragLeave={onDragExit}
  >
    { progress > 0 ? <ProgressBar progress={ progress }></ProgressBar> : null }
    <div className="flex-item">{ !readingFile ? props.children : "reading file ..." }</div>
  </div>
}

export default class App extends Component<AppProps, AppState> {
  constructor(props: React.Props<{}>) {
    super(props);
    this.state = {
      name: 'React'
    };
  }

  render() {
    return (
      <>
        <div className="container flex-container">
          <DropZone type="compress">Drop Here to <b>Compress</b></DropZone>
          <DropZone type="decompress">Drop Here to <b>Decompress</b></DropZone>
        </div>
        <div className="footer">fork me on github: <a href="https://github.com/jo32/demo-browser-compress">https://github.com/jo32/demo-browser-compress</a></div>
      </>
    );
  }
}