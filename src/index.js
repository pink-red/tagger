import React, { useEffect } from 'react'
import ReactDOM from 'react-dom'
import { program } from 'raj-react'
import { union } from 'tagmeme'
import _ from 'underscore'
import JSZip from 'jszip'
import { saveAs } from 'file-saver';
import { AutoTokenizer } from "@xenova/transformers"

import './index.css'


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


function filterFiles(searchTags, files) {
    if (searchTags.positive.length + searchTags.negative.length > 0) {
        return _.filter(files, f => {
            return searchTags.positive.every(t => f.tags.includes(t))
                && !searchTags.negative.some(t => f.tags.includes(t))
        })
    } else {
        return files
    }
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
  update (msg, state) {
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
                let file = state.filteredFiles[state.position]
                file.tags.push(tag)
                let uniqueTags = _.uniq(file.tags)
                if (file.tags.length !== uniqueTags.length) {
                    file.tags = _.uniq(file.tags)
                } else {
                    state.tagCounts[tag] = state.tagCounts[tag] || 0
                    state.tagCounts[tag] += 1
                }

                return [state]
            }
        },
        DeleteTag (tag) {
            let file = state.filteredFiles[state.position]
            file.tags = _.without(file.tags, tag)

            state.tagCounts[tag] -= 1

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
            query = query.trim()
            let searchTags = query.split(", ").map(x => x.trim())
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
            searchTags = {positive: positive, negative: negative}
            return [{...state, filteredFiles: filterFiles(searchTags, state.allFiles), position: 0}]
        }
    })
  },
  view (state, dispatch) {
    let {allFiles, filteredFiles, position, tagCounts, tokenizer} = state;

    return (
        <div className="container">
            <div>
                <input
                    type="file"
                    multiple
                    onChange={(e) => {
                        filesToTaggedImages(Array.from(e.target.files))
                            .then((files) => dispatch(Msg.UploadFiles(files)))
                    }} />
            </div>
            {
                (allFiles.length > 0) && <div>
                    <input
                        type="text"
                        placeholder="Search..."
                        onKeyUp={e => {
                            if (e.key === "Enter") {
                                dispatch(Msg.Search(e.target.value))
                            }
                        }}/>
                    {
                        (filteredFiles.length === 0)
                        ? <div> Nothing found. </div>
                        : <>
                            <div>
                                <button className="button" type="button" onClick={() => dispatch(Msg.Prev())}>Prev</button>
                                <button className="button" type="button" onClick={() => dispatch(Msg.Next())}>Next</button>
                                <button className="button download-tags-button" type="button" onClick={() => downloadTagsZip(allFiles, state.ignoredTags)}>Download Tags</button>
                            </div>
                            <div className="row">
                                <div className="left-column">
                                    <div className="file-info">
                                        [{position + 1} / {filteredFiles.length}] {filteredFiles[position].image.name}
                                    </div>
                                    <div>
                                        <FileImg file={filteredFiles[position].image}/>
                                    </div>
                                </div>
                                <div className="right-column">
                                    <input
                                        type="text"
                                        className="tag-input"
                                        placeholder="New tag..."
                                        onKeyUp={e => {
                                            if (e.key === "Enter") {
                                                dispatch(Msg.AddTag(e.target.value))
                                                e.target.value = ""
                                            }
                                        }}/>
                                    {
                                        // TODO
                                        // <span>Tokens: {tokenizer(filteredFiles[position].tags.join(", "))["input_ids"].size} / 75</span>
                                    }
                                    <div className="tags-list"> {
                                        sorted(_.difference(filteredFiles[position].tags, state.ignoredTags)).map((tag) => {
                                            return <div>
                                                <a className="wiki-link" href={danbooruWikiLinkForTag(tag)}>?</a>
                                                <span className="tag-text">{tag}</span>
                                                <span className="tag-count">{tagCounts[tag]}</span>
                                                <button
                                                    className="button delete-button"
                                                    type="button"
                                                    onClick={() => dispatch(Msg.DeleteTag(tag))}
                                                >
                                                    x
                                                </button>
                                                <button
                                                    className="button delete-button"
                                                    type="button"
                                                    onClick={() => dispatch(Msg.AddIgnoredTag(tag))}
                                                >
                                                    🛑
                                                </button>
                                            </div>
                                        })
                                    } </div>
                                </div>
                            </div>
                            <div>
                                <h3>Globally ignored tags</h3>
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
                                    <div> {
                                        sorted(state.ignoredTags).map((tag) => {
                                            return <div>
                                                <a className="wiki-link" href={danbooruWikiLinkForTag(tag)}>?</a>
                                                <span className="tag-text">{tag}</span>
                                                <button
                                                    className="button delete-button"
                                                    type="button"
                                                    onClick={() => dispatch(Msg.DeleteIgnoredTag(tag))}
                                                >
                                                    ↩️
                                                </button>
                                            </div>
                                        })
                                    } </div>
                            </div>
                        </>
                    }
                </div>
            }
        </div>
    )
  }
}))


ReactDOM.render(<Program />, document.getElementById('app'))
