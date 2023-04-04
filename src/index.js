import React, { useEffect, useCallback } from "react"
import ReactDOM from "react-dom"
import { program } from "raj-react"
import { union } from "tagmeme"
import _ from "underscore"
import JSZip from "jszip"
import { saveAs } from "file-saver";
import { AutoTokenizer } from "@xenova/transformers"

import "./index.css"


async function loadTokenizer(dispatch) {
    let tokenizer = await AutoTokenizer.from_pretrained(
//        "https://huggingface.co/Xenova/transformers.js/resolve/main/quantized/openai/clip-vit-base-patch16/default"
        "https://huggingface.co/openai/clip-vit-large-patch14/resolve/main"
    )
    dispatch(Msg.SetTokenizer(tokenizer))
}


function FileImg({file}) {
    let url = URL.createObjectURL(file);

    // free memory when component is unmounted
    useEffect(
        () => {
            return () => URL.revokeObjectURL(url)
        },
        [url],
    )

    return <img className="image" src={url} alt=""/>
}


function EditorShortcuts({dispatch}) {
    const handleKeyDown = useCallback(e => {
        if (e.target.tagName === "INPUT") {
            return
        }

        if (isFinite(e.key)) {  // is digit?
            dispatch(Msg.ApplyTagScript(document.getElementById(`tag-script-input-${e.key}`).value))
        } else if (e.key === "a" || e.key === "ArrowLeft") {
            dispatch(Msg.Prev())
        } else if (e.key === "d" || e.key === "ArrowRight") {
            dispatch(Msg.Next())
        }
    }, [dispatch])

    useEffect(() => {
        document.addEventListener("keydown", handleKeyDown)
        return () => document.removeEventListener("keydown", handleKeyDown)
    }, [handleKeyDown])

    return <></>
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
])


function loopIndex(idx, arrayLength) {
    return (idx + arrayLength) % arrayLength;
}


function sorted(arr, key = _.identity) {
    return _.sortBy(arr, key)
}


function downloadTagsZip(images, ignoredTags) {
    let zip = new JSZip()
    for (const image of images) {
        let tags = sorted(image.tags)
        tags = _.difference(tags, ignoredTags)

        zip.file(
            image.image.name + ".txt",
            tags.join(", "),
        )
    }
    zip.generateAsync({type: "blob"})
        .then(content => saveAs(content, "tags.zip"))
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
            const tags = _.uniq(tagStr.trim().split(", "))
            for (const tag of tags) {
                allTagsWithRepeats.push(tag)
            }

            taggedImages.push(
                {
                    image: file,
                    tags: tags,
                }
            )
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
    return `https://danbooru.donmai.us/wiki_pages/${tag.replace(" ", "_")}`
}


function parseSearchTags(query) {
    query = query.trim()

    let searchTags = query.split(",").map(x => x.trim())
    searchTags = _.filter(searchTags, t => t.length > 0)

    let positive = []
    let negative = []
    for (const tag of searchTags) {
        if (tag.startsWith("-")) {
            negative.push(tag.substring(1))
        } else {
            positive.push(tag)
        }
    }

    return {positive: positive, negative: negative}
}


function filterFiles(query, files) {
    let searchTags = parseSearchTags(query)

    if (searchTags.positive.length + searchTags.negative.length > 0) {
        return _.filter(files, f => {
            return searchTags.positive.every(t => f.tags.includes(t))
                && !searchTags.negative.some(t => f.tags.includes(t))
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


function update (msg, state) {
    return Msg.match(msg, {
        SetTokenizer (tokenizer) {
            return [{...state, tokenizer: tokenizer}]
        },
        UploadFiles (files) {
            let {taggedImages, tagCounts} = files
            return [
                {
                    ...state,
                    allFiles: taggedImages,
                    filteredFiles: taggedImages,
                    position: 0,
                    tagCounts: tagCounts,
                }
            ]
        },
        Prev () {
            return [{...state, position: loopIndex(state.position - 1, state.filteredFiles.length)}]
        },
        Next () {
            return [{...state, position: loopIndex(state.position + 1, state.filteredFiles.length)}]
        },
        AddTag (tag) {
            tag = tag.trim()
            if (tag.length === 0) {
                return [state]
            } else {
                state = addTag(state, tag)
                return [state]
            }
        },
        DeleteTag (tag) {
            state = deleteTag(state, tag)
            return [state]
        },
        ApplyTagScript (tagScript) {
            let { positive, negative } = parseSearchTags(tagScript)

            for (const t of positive) {
                state = addTag(state, t)
            }
            for (const t of negative) {
                state = deleteTag(state, t)
            }

            return [state]
        },
        AddIgnoredTag (tag) {
            tag = tag.trim()
            if (tag.length === 0) {
                return [state]
            } else {
                state.ignoredTags.push(tag)
                state.ignoredTags = _.uniq(state.ignoredTags)
                return [state]
            }
        },
        DeleteIgnoredTag (tag) {
            state.ignoredTags = _.without(state.ignoredTags, tag)
            return [state]
        },
        Search (query) {
            return [{...state, filteredFiles: filterFiles(query, state.allFiles), position: 0}]
        }
    })
}


function viewImageViewer(filteredFiles, position, dispatch) {
    return <div className="column">
        <div className="nav-buttons">
            <button className="button" type="button" onClick={() => dispatch(Msg.Prev())}>Prev</button>
            <div className="files-position">
                [{position + 1} / {filteredFiles.length}] {filteredFiles[position].image.name}
            </div>
            <button className="button" type="button" onClick={() => dispatch(Msg.Next())}>Next</button>
        </div>
        <div className="img-box">
            <FileImg file={filteredFiles[position].image}/>
        </div>
    </div>
}


function viewTagEditor(image, ignoredTags, tagCounts, dispatch) {
    return <div className="column right-column">
        <input
            type="text"
            className="tag-input"
            placeholder="New tag..."
            onKeyUp={e => {
                if (e.key === "Enter") {
                    dispatch(Msg.AddTag(e.target.value))
                    e.target.value = ""
                }
            }}
        />
        {
            // TODO
            // <span>Tokens: {tokenizer(image.tags.join(", "))["input_ids"].size} / 75</span>
        }
        <div className="tags-list"> {
            sorted(_.difference(image.tags, ignoredTags)).map((tag) => {
                return <div className="tag" key={tag}>
                    <a className="wiki-link" href={danbooruWikiLinkForTag(tag)} target="_blank" rel="noreferrer">?</a>
                    <div className="tag-info">
                        <span className="tag-text">{tag}</span>
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
            })
        } </div>
    </div>
}


function viewTagsBlacklistEditor(ignoredTags, tagCounts, dispatch) {
    return <div>
        <span>Tags blacklist</span>
            <input
                type="text"
                className="tag-input"
                placeholder="New tag..."
                onKeyUp={e => {
                    if (e.key === "Enter") {
                        dispatch(Msg.AddIgnoredTag(e.target.value))
                        e.target.value = ""
                    }
                }}/>
            <div className="tags-list"> {
                sorted(ignoredTags).map((tag) => {
                    return <div className="tag" key={tag}>
                        <a className="wiki-link" href={danbooruWikiLinkForTag(tag)}>?</a>
                        <span className="tag-text">{tag}</span>
                        <span className="tag-count">{tagCounts[tag]}</span>
                        <button
                            className="tag-button delete-tag-button"
                            type="button"
                            onClick={() => dispatch(Msg.DeleteIgnoredTag(tag))}
                        >
                            ×
                        </button>
                    </div>
                })
            } </div>
    </div>
}


function viewTagScript(n) {
    return <div className="tag-script-box" key={n}>
        <label htmlFor={`tag-script-input-${n}`}> { n } </label>
        <input
            type="text"
            id={`tag-script-input-${n}`}
            className="tag-input"
            placeholder="Tag script..."
        />
    </div>
}


function viewEditor(state, dispatch) {
    let { filteredFiles, position, tagCounts, ignoredTags } = state

    return <>
        <div className="row">
            <div className="column">
                { _.range(1, 9+1).map(viewTagScript) }
                { viewTagScript(0) }
            </div>
            { viewImageViewer(filteredFiles, position, dispatch) }
            { viewTagEditor(filteredFiles[position], ignoredTags, tagCounts, dispatch) }
        </div>
        { viewTagsBlacklistEditor(ignoredTags, tagCounts, dispatch) }
    </>
}


function viewUploadFilesButton(dispatch) {
    return <>
        <input
            id="file-input"
            type="file"
            style={{display: "none"}}
            multiple
            onChange={(e) => {
                filesToTaggedImages(Array.from(e.target.files))
                    .then((files) => dispatch(Msg.UploadFiles(files)))
            }} />
        <button
            className="button"
            type="button"
            onClick={() => document.getElementById("file-input").click()}
        >
            Upload files
        </button>
    </>
}


function viewSearchField(dispatch) {
    return <input
        type="text"
        id="search-input"
        placeholder="Search..."
        onKeyUp={e => {
            if (e.key === "Enter") {
                dispatch(Msg.Search(e.target.value))
            }
        }
    }/>
}


function viewDownloadTagsButton(allFiles, ignoredTags) {
    return <button
            className="button"
            type="button"
            onClick={() => downloadTagsZip(allFiles, ignoredTags)}
        >
            Download tags
    </button>
}


function view (state, dispatch) {
    let {allFiles, filteredFiles, ignoredTags} = state;

    return (
        <div className="container" tabIndex="0">
            <div className="file-input-row">
                { viewUploadFilesButton(dispatch) }
                {
                    (allFiles.length > 0) && <>
                        { viewSearchField(dispatch) }
                        { viewDownloadTagsButton(allFiles, ignoredTags) }
                    </>
                }
            </div>
            {
                (allFiles.length > 0) && <>
                    {
                        (filteredFiles.length === 0)
                        ? <div> Nothing found. </div>
                        : <>
                            { viewEditor(state, dispatch) }
                            {/* only enable shortcuts when an image is being shown */}
                            <EditorShortcuts dispatch={dispatch}/>
                        </>
                    }
                </>
            }
        </div>
    )
}


const Program = program(React.Component, () => ({
  init: [
    {
        allFiles: [],
        filteredFiles: [],
        position: 0,
        tagCounts: {},
        tokenizer: undefined,
        ignoredTags: [],
    },
    loadTokenizer,
  ],
  update,
  view,
}))


ReactDOM.render(<Program/>, document.getElementById("app"))
