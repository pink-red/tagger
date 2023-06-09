import React, { useEffect } from "react"
import * as ReactDOMClient from 'react-dom/client'
import { program } from "raj-react"
import { union } from "tagmeme"
import _ from "underscore"
import JSZip from "jszip"
import { saveAs } from "file-saver"
import { AutoTokenizer, getModelFile } from "@xenova/transformers"
import * as ort from "onnxruntime-web"
import Papa from "papaparse"

import "./index.css"
import mainPy from "./main.py"

async function loadTokenizer(dispatch) {
  let tokenizer = await AutoTokenizer.from_pretrained(
    "https://huggingface.co/openai/clip-vit-large-patch14/resolve/main"
//    "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/tokenizer"
  )
  dispatch(Msg.SetTokenizer(tokenizer))
}

async function fileToBase64(file) {
  return await new Promise((resolve) => {
    let reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(file)
  })
}

async function loadAutoTagger(dispatch) {
  let pyodide = await window.loadPyodide()
  // TODO: freeze versions
  await pyodide.loadPackage(
    [
      "pillow",
      "numpy",
      "opencv-python",
    ]
  )

  await pyodide.runPythonAsync(await (await fetch(mainPy)).text())
  let pyfuncPreprocessImage = pyodide.globals.get("preprocess_image")

  let modelBuffer = await getModelFile(
    "https://huggingface.co/SmilingWolf/wd-v1-4-vit-tagger-v2/resolve/main",
    "model.onnx",
    ((data) => {
      if (data.status === "progress") {
        dispatch(
          Msg.SetAutoTagger({
            state: "loading",
            loadingProgress: data.progress,
            predict: predict,
          })
        )
      }
    }),
  )
  let tagsBuffer = await getModelFile(
    "https://huggingface.co/SmilingWolf/wd-v1-4-vit-tagger-v2/resolve/main",
    "selected_tags.csv",
  )
  let tags = await new Promise((resolve, reject) => {
    Papa.parse(
      new Blob([tagsBuffer]),
      {
        complete: (x) => resolve(x.data),
        error: reject,
        header: true,
        skipEmptyLines: true,
      },
    )
  })

  // Tell onnxruntime to execute models in a Web Worker
  // (to use multiple CPU cores)
  ort.env.wasm.proxy = true

  let model = await ort.InferenceSession.create(
    modelBuffer,
    {
        executionProviders: ["wasm"],
        executionMode: "parallel",
        graphOptimizationLevel: "all",
    },
  )

  async function predict(file, position, dispatch) {
    dispatch(
      Msg.SetAutoTagger({
        state: "busy",
        loadingProgress: null,
        predict: predict,
      })
    )

    let fileB64 = await fileToBase64(file)
    fileB64 = fileB64.split(",")[1]

    // see: https://huggingface.co/spaces/SmilingWolf/wd-v1-4-tags/blob/b079c7b14601afefd3064c6711810217eb87f637/app.py

    // TODO: get target image size from the model (un-hardcode 448)
    let proxy = pyfuncPreprocessImage(fileB64, 448)
    let buffer = proxy.getBuffer()
    proxy.destroy()

    // .slice(0) here copies the ArrayBuffer to allow passing it to a Web Worker
    // (because we set ort.env.wasm.proxy = true)
    // see also: https://github.com/pyodide/pyodide/issues/1961
    let tensor = new ort.Tensor("float32", buffer.data.slice(0), buffer.shape)

    let inputs = {}
    inputs[model.inputNames[0]] = tensor
    let probs = await model.run(inputs, [model.outputNames[0]])
    probs = probs.predictions_sigmoid.data

    let autoTags = _.zip(tags, probs).map(([tag, prob]) => {
      return {
        name: tag.name,
        prob: prob,
        category: tag.category,
      }
    })
    autoTags = (
        autoTags
        .filter((x) => x.prob >= 0.35)
        .filter((x) => x.category === "0")
        .map((x) => x.name)
    )
    autoTags = sorted(autoTags)

    dispatch(Msg.SetAutoTags({position, autoTags}))

    dispatch(
      Msg.SetAutoTagger({
        state: "ready",
        loadingProgress: null,
        predict: predict,
      })
    )
  }

  dispatch(
    Msg.SetAutoTagger({
      state: "ready",
      loadingProgress: null,
      predict: predict,
    })
  )
}

const Msg = union([
  "SetTokenizer",
  "SetAutoTagger",
  "ImportFiles",
  "Prev",
  "Next",
  "AddTag",
  "DeleteTag",
  "AddIgnoredTag",
  "DeleteIgnoredTag",
  "Search",
  "ApplyTagScript",
  "SetMode",
  "SwitchToImage",
  "ToggleTagScripts",
  "UpdateTagInputValue",
  "UpdateSearchInputValue",
  "SetAutoTags",
])

function loopIndex(idx, arrayLength) {
  return (idx + arrayLength) % arrayLength
}

function sorted(arr, key = _.identity) {
  return _.sortBy(arr, key)
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function exportTagsZip(images, ignoredTags) {
  let zip = new JSZip()
  for (const image of images) {
    let tags = sorted(image.tags)
    tags = _.difference(tags, ignoredTags)
    tags = tags.map((t) => t.replaceAll("_", " "))

    zip.file(image.image.name + ".txt", tags.join(", "))
  }
  zip
    .generateAsync({ type: "blob" })
    .then((content) => saveAs(content, "tags.zip"))
}

function splitFilenameExt(filename) {
  let lastDot = filename.lastIndexOf(".")
  let name = filename.slice(0, lastDot)
  let ext = filename.slice(lastDot + 1)

  return [name, ext]
}

async function filesToTaggedImages(files) {
  let allowedExtensions = [
    "gif",
    "jpg",
    "jpeg",
    "png",
    "wepb",
  ]

  files = sorted(files, "name")
  const indexedFiles = _.indexBy(files, "name")

  let allTagsWithRepeats = []
  let taggedImages = []
  for (const file of files) {
    let [filenameNoExt, ext] = splitFilenameExt(file.name)

    if (allowedExtensions.includes(ext)) {
      let tagStr
      if (indexedFiles.hasOwnProperty(file.name + ".txt")) {
        tagStr = await indexedFiles[file.name + ".txt"].text()
      } else if (indexedFiles.hasOwnProperty(filenameNoExt + ".txt")) {
        tagStr = await indexedFiles[filenameNoExt + ".txt"].text()
      } else {
        tagStr = ""
      }

      const tags = parse_tags_comma_separated(tagStr)
      for (const tag of tags) {
        allTagsWithRepeats.push(tag)
      }

      let url = URL.createObjectURL(file)

      taggedImages.push({
        image: file,
        tags: tags,
        url: url,
        autoTags: null,
      })
    }
  }

  const tagRepeatsByTag = _.groupBy(allTagsWithRepeats, _.identity)
  const tagCounts = _.mapObject(tagRepeatsByTag, "length")

  return {
    taggedImages: taggedImages,
    tagCounts: tagCounts,
  }
}

function danbooruWikiLinkForTag(tag) {
  return `https://danbooru.donmai.us/wiki_pages/${tag}`
}

function parse_tags_comma_separated(tagsStr) {
  let tags = tagsStr.split(",").map((x) => x.trim())
  tags = _.filter(tags, (t) => t.length > 0)
  tags = _.uniq(tags)
  tags = tags.map((t) => t.replaceAll(" ", "_"))
  return tags
}

function parse_tags_underscores(tagsStr) {
  let tags = tagsStr.split(" ").map((x) => x.trim())
  tags = _.filter(tags, (t) => t.length > 0)
  tags = _.uniq(tags)
  return tags
}

function parseSearchTags(query) {
  let searchTags = parse_tags_underscores(query)

  let positive = []
  let negative = []
  for (const tag of searchTags) {
    if (tag.startsWith("-")) {
      negative.push(tag.substring(1))
    } else {
      positive.push(tag)
    }
  }

  return { positive: positive, negative: negative }
}

function tagsContainMatch(tags, pattern) {
  let regex = new RegExp(
    "^" + escapeRegExp(pattern).replaceAll("\\*", ".*") + "$"
  )
  for (const t of tags) {
    if (t.match(regex)) {
      return true
    }
  }
  return false
}

function filterFiles(query, files) {
  let { positive, negative } = parseSearchTags(query)

  if (positive.length + negative.length > 0) {
    return _.filter(files, (f) => {
      return (
        positive.every((t) => tagsContainMatch(f.tags, t)) &&
        !negative.some((t) => tagsContainMatch(f.tags, t))
      )
    })
  } else {
    return files
  }
}

// FIXME: mutation
function addTag(state, tag) {
  let file = state.filteredFiles[state.position]

  file.tags.push(tag)
  let uniqueTags = _.uniq(file.tags)
  if (file.tags.length !== uniqueTags.length) {
    file.tags = uniqueTags
  } else {
    state.tagCounts[tag] = state.tagCounts[tag] || 0
    state.tagCounts[tag] += 1
  }

  return state
}

function deleteTag(state, tag) {
  let file = state.filteredFiles[state.position]

  let newTags = _.without(file.tags, tag)
  if (file.tags.length !== newTags.length) {
    file.tags = newTags
    state.tagCounts[tag] = state.tagCounts[tag] || 0
    state.tagCounts[tag] -= 1
  }

  return state
}

function update(msg, state) {
  return Msg.match(msg, {
    SetTokenizer(tokenizer) {
      return [{ ...state, tokenizer: tokenizer }]
    },
    SetAutoTagger(autoTagger) {
      return [{ ...state, autoTagger: autoTagger }]
    },
    ImportFiles(files) {
      let { taggedImages, tagCounts } = files
      return [
        {
          ...makeInitialModel(),
          tokenizer: state.tokenizer,
          autoTagger: state.autoTagger,
          mode: state.mode,
          allFiles: taggedImages,
          filteredFiles: taggedImages,
          tagCounts: tagCounts,
        },
      ]
    },
    Prev() {
      return [
        {
          ...state,
          position: loopIndex(state.position - 1, state.filteredFiles.length),
        },
      ]
    },
    Next() {
      return [
        {
          ...state,
          position: loopIndex(state.position + 1, state.filteredFiles.length),
        },
      ]
    },
    AddTag(tag) {
      tag = tag.trim()
      if (tag.length === 0) {
        return [state]
      } else {
        state = addTag(state, tag)
        return [{ ...state, tagInputValue: "" }]
      }
    },
    DeleteTag(tag) {
      state = deleteTag(state, tag)
      return [state]
    },
    ApplyTagScript(tagScript) {
      let { positive, negative } = parseSearchTags(tagScript)

      for (const t of positive) {
        state = addTag(state, t)
      }
      for (const t of negative) {
        state = deleteTag(state, t)
      }

      return [state]
    },
    AddIgnoredTag(tag) {
      tag = tag.trim()
      if (tag.length === 0) {
        return [state]
      } else {
        state.ignoredTags.push(tag)
        state.ignoredTags = _.uniq(state.ignoredTags)
        return [state]
      }
    },
    DeleteIgnoredTag(tag) {
      state.ignoredTags = _.without(state.ignoredTags, tag)
      return [state]
    },
    Search(query) {
      return [
        {
          ...state,
          filteredFiles: filterFiles(query, state.allFiles),
          position: 0,
        },
      ]
    },
    SetMode(mode) {
      return [{ ...state, mode: mode }]
    },
    SwitchToImage(position) {
      return [{ ...state, mode: "image", position: position }]
    },
    ToggleTagScripts() {
      return [{ ...state, tagScriptsEnabled: !state.tagScriptsEnabled }]
    },
    UpdateTagInputValue(value) {
      return [{ ...state, tagInputValue: value }]
    },
    UpdateSearchInputValue(value) {
      return [{ ...state, searchInputValue: value }]
    },
    SetAutoTags({position, autoTags}) {
      let file = state.filteredFiles[position]
      file = { ...file, autoTags: autoTags }
      state.filteredFiles[position] = file  // FIXME: mutation
      return [state]
    },
  })
}

function viewImageViewer(filteredFiles, position, autoTagger, dispatch) {
  return (
    <div className="image-column column">
      <div className="nav-buttons">
        <button
          className="button"
          type="button"
          onClick={() => dispatch(Msg.Prev())}
        >
          Prev
        </button>
        <div className="files-position">
          [{position + 1} / {filteredFiles.length}]
          {" "}
          {filteredFiles[position].image.name}
        </div>
        <button
          className="button"
          type="button"
          onClick={() => dispatch(Msg.Next())}
        >
          Next
        </button>
      </div>
      <div className="img-box">
        <img className="image" src={filteredFiles[position].url} alt="" />
      </div>
    </div>
  )
}

function viewTokens(tokenizer, tags) {
  let numOfTokens = tokenizer(
    tags.map((t) => t.replaceAll("_", " ")).join(", ")
  )["input_ids"].size

  return <span> Tokens: {numOfTokens} / 77 </span>
}

function viewAutoTagButton(image, position, autoTagger, dispatch) {
  if (autoTagger.state === "loading") {
    let prog = autoTagger.loadingProgress
    return <button
      className="button"
      type="button"
      disabled={true}
      style={{
        background: `linear-gradient(to right, #0d45a5, #0d45a5 ${prog}%, #67707f ${prog}%, #67707f)`,
        transition: "background 0.2s ease-in-out"
      }}
    >
      Loading model...
    </button>
  }

  let text
  let isEnabled
  if (autoTagger.state === "ready") {
    text = "Predict"
    isEnabled = true
  } else if (autoTagger.state === "busy") {
    text = "Predicting..."
    isEnabled = false
  }

  return (
    <button
      className="button"
      type="button"
      disabled={!isEnabled}
      onClick={() => autoTagger.predict(image, position, dispatch)}
    >
      {text}
    </button>
  )
}

function viewAutoTags(file, position, autoTagger, ignoredTags, dispatch) {
  let visibleTags = []
  if (file.autoTags !== null) {
    visibleTags = file.autoTags
    visibleTags = _.difference(visibleTags, ignoredTags)
    visibleTags = _.difference(visibleTags, file.tags)
  }

  return <div className="column auto-tags-column">
    <span className="column-name">Auto tags</span>
    {viewAutoTagButton(file.image, position, autoTagger, dispatch)}
    <div className="tags-list">
      {visibleTags.map((tag) => {
        return (
          <div className="tag" key={tag}>
            <a
              className="wiki-link"
              href={danbooruWikiLinkForTag(tag)}
              target="_blank"
              rel="noreferrer"
            >
              ?
            </a>
            <div className="tag-info">
              <span className="tag-text">{tag.replaceAll("_", " ")}</span>
            </div>
            <div className="tag-buttons">
              <button
                className="tag-button add-tag-button"
                type="button"
                onClick={() => dispatch(Msg.AddTag(tag))}
              >
                +
              </button>
              <button
                className="tag-button add-global-button"
                type="button"
                onClick={() => dispatch(Msg.AddIgnoredTag(tag))}
              >
                &nbsp;
              </button>
            </div>
          </div>
        )
      })}
    </div>
  </div>
}

function viewTagEditor(
  image,
  ignoredTags,
  tagCounts,
  tagInputValue,
  tokenizer,
  dispatch
) {
  let visibleTags = sorted(_.difference(image.tags, ignoredTags))

  return (
    <div className="column right-column">
      <span className="column-name">Tags</span>
      <input
        type="text"
        className="tag-input"
        placeholder="New tag..."
        value={tagInputValue}
        onChange={(e) => dispatch(Msg.UpdateTagInputValue(e.target.value))}
        onKeyUp={(e) => {
          if (e.code === "Enter") {
            dispatch(Msg.AddTag(e.target.value))
          }
        }}
      />
      {viewTokens(tokenizer, visibleTags)}
      <div className="tags-list">
        {visibleTags.map((tag) => {
          return (
            <div className="tag" key={tag}>
              <a
                className="wiki-link"
                href={danbooruWikiLinkForTag(tag)}
                target="_blank"
                rel="noreferrer"
              >
                ?
              </a>
              <div className="tag-info">
                <span className="tag-text">{tag.replaceAll("_", " ")}</span>
                <span className="tag-count">{tagCounts[tag]}</span>
              </div>
              <div className="tag-buttons">
                <button
                  className="tag-button delete-tag-button"
                  type="button"
                  onClick={() => dispatch(Msg.DeleteTag(tag))}
                >
                  ×
                </button>
                <button
                  className="tag-button add-global-button"
                  type="button"
                  onClick={() => dispatch(Msg.AddIgnoredTag(tag))}
                >
                  &nbsp;
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function viewTagsBlacklistEditor(ignoredTags, tagCounts, dispatch) {
  return (
    <div className="column">
      <span className="column-name">Tags blacklist</span>
      <input
        type="text"
        className="tag-input"
        placeholder="New tag..."
        onKeyUp={(e) => {
          if (e.code === "Enter") {
            dispatch(Msg.AddIgnoredTag(e.target.value))
            e.target.value = ""
          }
        }}
      />
      <div className="tags-list">
        {sorted(ignoredTags).map((tag) => {
          return (
            <div className="tag" key={tag}>
              <a className="wiki-link" href={danbooruWikiLinkForTag(tag)}>
                ?
              </a>
              <span className="tag-text">{tag.replaceAll("_", " ")}</span>
              <span className="tag-count">{tagCounts[tag]}</span>
              <button
                className="tag-button delete-tag-button"
                type="button"
                onClick={() => dispatch(Msg.DeleteIgnoredTag(tag))}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TagScriptsShortcuts({ dispatch }) {
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.target.tagName === "INPUT") {
        return
      }

      if (/^[0-9]$/.test(e.key)) {
        dispatch(
          Msg.ApplyTagScript(
            document.getElementById(`tag-script-input-${e.key}`).value
          )
        )
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  })

  return <></>
}

function viewTagScript(n) {
  return (
    <div className="tag-script-box" key={n}>
      <label htmlFor={`tag-script-input-${n}`}> {n} </label>
      <input
        type="text"
        id={`tag-script-input-${n}`}
        className="tag-input"
        placeholder="Tag script..."
      />
    </div>
  )
}

function EditorShortcuts({ dispatch }) {
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.target.tagName === "INPUT") {
        return
      }
      if (
        e.getModifierState("Alt") ||
        e.getModifierState("Control") ||
        e.getModifierState("Meta") ||
        e.getModifierState("Shift") ||
        e.getModifierState("OS")
      ) {
        return
      }

      if (e.code === "KeyA" || e.code === "ArrowLeft") {
        dispatch(Msg.Prev())
      } else if (e.code === "KeyD" || e.code === "ArrowRight") {
        dispatch(Msg.Next())
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  })

  return <></>
}

function viewEditor(state, dispatch) {
  let {
    filteredFiles,
    position,
    tagCounts,
    ignoredTags,
    tagScriptsEnabled,
    tagInputValue,
    tokenizer,
    autoTagger,
  } = state

  return (
    <>
      <div className="row">
        {viewImageViewer(filteredFiles, position, autoTagger, dispatch)}
        {viewTagEditor(
          filteredFiles[position],
          ignoredTags,
          tagCounts,
          tagInputValue,
          tokenizer,
          dispatch
        )}
        {viewTagsBlacklistEditor(ignoredTags, tagCounts, dispatch)}
        {tagScriptsEnabled && (
          <div className="tag-script-column column">
            <span className="column-name">Tag scripts</span>
            {_.range(1, 9 + 1).map(viewTagScript)}
            {viewTagScript(0)}
            <TagScriptsShortcuts dispatch={dispatch} />
          </div>
        )}
        {viewAutoTags(
          filteredFiles[position],
          position,
          autoTagger,
          ignoredTags,
          dispatch,
        )}
        {/* only enable shortcuts when the editor is being shown */}
        <EditorShortcuts dispatch={dispatch} />
      </div>
    </>
  )
}

function viewImportFilesButton(currentFiles, dispatch) {
  return (
    <>
      <input
        id="file-input"
        type="file"
        style={{ display: "none" }}
        multiple
        onChange={(e) => {
          currentFiles.forEach((f) => URL.revokeObjectURL(f.url))
          filesToTaggedImages(Array.from(e.target.files)).then((files) =>
            dispatch(Msg.ImportFiles(files))
          )
        }}
      />
      <button
        className="button"
        type="button"
        onClick={() => document.getElementById("file-input").click()}
      >
        Import files
      </button>
    </>
  )
}

function viewSearchField(searchInputValue, dispatch) {
  return (
    <input
      type="text"
      id="search-input"
      placeholder="Search..."
      value={searchInputValue}
      onChange={(e) => dispatch(Msg.UpdateSearchInputValue(e.target.value))}
      onKeyUp={(e) => {
        if (e.code === "Enter") {
          dispatch(Msg.Search(e.target.value))
        }
      }}
    />
  )
}

function viewExportTagsButton(allFiles, ignoredTags) {
  return (
    <button
      className="button"
      type="button"
      onClick={() => exportTagsZip(allFiles, ignoredTags)}
    >
      Export tags
    </button>
  )
}

function viewGallery(filteredFiles, dispatch) {
  return (
    <div className="gallery">
      {filteredFiles.map((file, i) => (
        <div
          className="thumbnail-div"
          key={file.image.name}
          onClick={() => dispatch(Msg.SwitchToImage(i))}
        >
          <img className="thumbnail" src={file.url} alt="" />
        </div>
      ))}
    </div>
  )
}

function viewModeToggle(mode, dispatch) {
  if (mode === "image") {
    return (
      <>
        <button
          className="button"
          type="button"
          onClick={() => dispatch(Msg.SetMode("gallery"))}
        >
          To gallery
        </button>
      </>
    )
  } else {
    return (
      <>
        <button
          className="button"
          type="button"
          onClick={() => dispatch(Msg.SetMode("image"))}
        >
          Back to image
        </button>
      </>
    )
  }
}

function viewTagScriptsToggle(tagScriptsEnabled, dispatch) {
  return (
    <input
      type="checkbox"
      checked={tagScriptsEnabled}
      onChange={() => dispatch(Msg.ToggleTagScripts())}
    />
  )
}

function view(state, dispatch) {
  let {
    allFiles,
    filteredFiles,
    ignoredTags,
    mode,
    tagScriptsEnabled,
    searchInputValue,
  } = state

  return (
    <div className="container">
      <div className="file-input-row">
        {viewImportFilesButton(allFiles, dispatch)}
        {allFiles.length > 0 && (
          <>
            {viewSearchField(searchInputValue, dispatch)}
            {viewModeToggle(mode, dispatch)}
            {viewTagScriptsToggle(tagScriptsEnabled, dispatch)}
            {viewExportTagsButton(allFiles, ignoredTags)}
          </>
        )}
      </div>
      {
        (allFiles.length > 0) ? (
          <>
            {filteredFiles.length === 0 ? (
              <div> Nothing found. </div>
            ) : mode === "image" ? (
              viewEditor(state, dispatch)
            ) : (
              viewGallery(filteredFiles, dispatch)
            )}
          </>
        ) : (
          <div className="instruction">
            <p>
              Click the button to import the images.
            </p>
            <p>
              To also import the tags, use one of the following file naming schemes:
              <ul>
                <li>image.png</li>
                <li>image.txt</li>
                <li>another-image.jpg</li>
                <li>another-image.txt</li>
                <li>...</li>
              </ul>
              or
              <ul>
                <li>image.png</li>
                <li>image.png.txt</li>
                <li>example.webp</li>
                <li>example.webp.txt</li>
                <li>...</li>
              </ul>
            </p>
            <p>
              Note: this app runs entirely in the browser, including the auto tagging feature.
            </p>
            <p>
              No need to install anything and no data will be sent anywhere.
            </p>
            <p>
              Source code: <a href="https://github.com/pink-red/tagger/">https://github.com/pink-red/tagger/</a>
            </p>
          </div>
        )
      }
    </div>
  )
}

function makeInitialModel() {
  return {
    allFiles: [],
    filteredFiles: [],
    position: 0,
    tagCounts: {},
    tokenizer: null,
    autoTagger: {
        state: "loading",  // loading | ready | busy
        loadingProgress: 0,
        predict: null,
    },
    ignoredTags: [],
    mode: "gallery",  // gallery | image
    tagScriptsEnabled: false,
    tagInputValue: "",
    searchInputValue: "",
  }
}

const Program = program(React.Component, () => ({
  init: [
    makeInitialModel(),
    (dispatch) => {
      loadTokenizer(dispatch)
      loadAutoTagger(dispatch)
    }
  ],
  update,
  view,
}))

ReactDOMClient.createRoot(document.getElementById("app")).render(<Program />)
