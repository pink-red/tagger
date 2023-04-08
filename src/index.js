import React, { useEffect } from "react"
import ReactDOM from "react-dom"
import { program } from "raj-react"
import { union } from "tagmeme"
import _ from "underscore"
import JSZip from "jszip"
import { saveAs } from "file-saver"
import { AutoTokenizer } from "@xenova/transformers"

import "./index.css"

async function loadTokenizer(dispatch) {
  let tokenizer = await AutoTokenizer.from_pretrained(
    "https://huggingface.co/openai/clip-vit-large-patch14/resolve/main"
  )
  dispatch(Msg.SetTokenizer(tokenizer))
}

const Msg = union([
  "SetTokenizer",
  "UploadFiles",
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
])

function loopIndex(idx, arrayLength) {
  return (idx + arrayLength) % arrayLength
}

function sorted(arr, key = _.identity) {
  return _.sortBy(arr, key)
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function downloadTagsZip(images, ignoredTags) {
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

async function filesToTaggedImages(files) {
  files = sorted(files, "name")
  const indexedFiles = _.indexBy(files, "name")

  let allTagsWithRepeats = []
  let taggedImages = []
  for (const file of files) {
    if (!file.name.endsWith(".txt")) {
      let tagStr
      try {
        tagStr = await indexedFiles[file.name + ".txt"].text()
      } catch (e) {
        // happens when there's only an image, but no tag file
        if (e instanceof TypeError) {
          // TODO: show warning or create an empty list of tags?
          continue
        } else {
          throw e
        }
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
  let regex = new RegExp("^" + escapeRegExp(pattern).replaceAll("\\*", ".*") + "$")
  for (const t of tags) {
    if (t.match(regex)) {
      return true
    }
  }
  return false
}

function filterFiles(query, files) {
  let {positive, negative} = parseSearchTags(query)

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
    UploadFiles(files) {
      let { taggedImages, tagCounts } = files
      return [
        {
          ...makeInitialModel(),
          tokenizer: state.tokenizer,
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
    UpdateTagInputValue (value) {
      return [{ ...state, tagInputValue: value }]
    },
    UpdateSearchInputValue (value) {
      return [{ ...state, searchInputValue: value }]
    },
  })
}

function viewImageViewer(filteredFiles, position, dispatch) {
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
          [{position + 1} / {filteredFiles.length}]{" "}
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

function viewTagEditor(image, ignoredTags, tagCounts, tagInputValue, dispatch) {
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
      {
        // TODO
        // <span>Tokens: {tokenizer(image.tags.join(", "))["input_ids"].size} / 75</span>
      }
      <div className="tags-list">
        {" "}
        {sorted(_.difference(image.tags, ignoredTags)).map((tag) => {
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
        })}{" "}
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
        {" "}
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
        })}{" "}
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
  let { filteredFiles, position, tagCounts, ignoredTags, tagScriptsEnabled, tagInputValue } =
    state

  return (
    <>
      <div className="row">
        {viewImageViewer(filteredFiles, position, dispatch)}
        {viewTagEditor(
          filteredFiles[position],
          ignoredTags,
          tagCounts,
          tagInputValue,
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
        {/* only enable shortcuts when the editor is being shown */}
        <EditorShortcuts dispatch={dispatch} />
      </div>
    </>
  )
}

function viewUploadFilesButton(currentFiles, dispatch) {
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
            dispatch(Msg.UploadFiles(files))
          )
        }}
      />
      <button
        className="button"
        type="button"
        onClick={() => document.getElementById("file-input").click()}
      >
        Upload files
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

function viewDownloadTagsButton(allFiles, ignoredTags) {
  return (
    <button
      className="button"
      type="button"
      onClick={() => downloadTagsZip(allFiles, ignoredTags)}
    >
      Download tags
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
  let { allFiles, filteredFiles, ignoredTags, mode, tagScriptsEnabled, searchInputValue } = state

  return (
    <div className="container">
      <div className="file-input-row">
        {viewUploadFilesButton(allFiles, dispatch)}
        {allFiles.length > 0 && (
          <>
            {viewSearchField(searchInputValue, dispatch)}
            {viewModeToggle(mode, dispatch)}
            {viewTagScriptsToggle(tagScriptsEnabled, dispatch)}
            {viewDownloadTagsButton(allFiles, ignoredTags)}
          </>
        )}
      </div>
      {allFiles.length > 0 && (
        <>
          {filteredFiles.length === 0 ? (
            <div> Nothing found. </div>
          ) : mode === "image" ? (
            viewEditor(state, dispatch)
          ) : (
            viewGallery(filteredFiles, dispatch)
          )}
        </>
      )}
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
    ignoredTags: [],
    mode: "gallery",
    tagScriptsEnabled: false,
    tagInputValue: "",
    searchInputValue: "",
  }
}

const Program = program(React.Component, () => ({
  init: [makeInitialModel(), loadTokenizer],
  update,
  view,
}))

ReactDOM.render(<Program />, document.getElementById("app"))
