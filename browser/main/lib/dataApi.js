const keygen = require('browser/lib/keygen')
const CSON = require('season')
const path = require('path')
const _ = require('lodash')
const sander = require('sander')

let storages = []
let notes = []

let queuedTasks = []

function queueSaveFolder (storageKey, folderKey) {
  let storage = _.find(storages, {key: storageKey})
  if (storage == null) throw new Error('Failed to queue: Storage doesn\'t exist.')

  let targetTasks = queuedTasks.filter((task) => task.storage === storageKey && task.folder === folderKey)
  targetTasks.forEach((task) => {
    clearTimeout(task.timer)
  })
  queuedTasks = queuedTasks.filter((task) => task.storage !== storageKey || task.folder !== folderKey)

  let newTimer = setTimeout(() => {
    let folderNotes = notes.filter((note) => note.storage === storageKey && note.folder === folderKey)
    sander
      .writeFile(path.join(storage.cache.path, folderKey, 'data.json'), JSON.stringify({
        notes: folderNotes
      }))
  }, 1500)

  queuedTasks.push({
    storage: storageKey,
    folder: folderKey,
    timer: newTimer
  })
}

class Storage {
  constructor (cache) {
    this.key = cache.key
    this.cache = cache
  }

  loadJSONData () {
    return new Promise((resolve, reject) => {
      try {
        let data = CSON.readFileSync(path.join(this.cache.path, 'boostnote.json'))
        this.data = data
        resolve(this)
      } catch (err) {
        reject(err)
      }
    })
  }

  toJSON () {
    return Object.assign({}, this.cache, this.data)
  }

  initStorage () {
    return this.loadJSONData()
      .catch((err) => {
        console.error(err.code)
        if (err.code === 'ENOENT') {
          let initialStorage = {
            folders: []
          }
          return sander.writeFile(path.join(this.cache.path, 'boostnote.json'), JSON.stringify(initialStorage))
        } else throw err
      })
      .then(() => this.loadJSONData())
  }

  saveData () {
    return sander
      .writeFile(path.join(this.cache.path, 'boostnote.json'), JSON.stringify(this.data))
      .then(() => this)
  }

  saveCache () {
    _saveCaches()
  }

  static forge (cache) {
    let instance = new this(cache)
    return instance
  }
}

class Note {
  constructor (note) {
    this.storage = note.storage
    this.folder = note.folder
    this.key = note.key
    this.uniqueKey = `${note.storage}-${note.folder}-${note.key}`
    this.data = note
  }

  toJSON () {
    return Object.assign({}, this.data, {
      uniqueKey: this.uniqueKey
    })
  }

  save () {
    let storage = _.find(storages, {key: this.storage})
    if (storage == null) return Promise.reject(new Error('Storage doesn\'t exist.'))
    let folder = _.find(storage.data.folders, {key: this.folder})
    if (folder == null) return Promise.reject(new Error('Storage doesn\'t exist.'))

    // FS MUST BE MANIPULATED BY ASYNC METHOD
    queueSaveFolder(storage.key, folder.key)
    return Promise.resolve(this)
  }

  static forge (note) {
    let instance = new this(note)

    return Promise.resolve(instance)
  }
}

function init () {
  let fetchStorages = function () {
    let caches
    try {
      caches = JSON.parse(localStorage.getItem('storages'))
    } catch (e) {
      console.error(e)
      caches = []
      localStorage.getItem('storages', JSON.stringify(caches))
    }

    return caches.map((cache) => {
      return Storage
        .forge(cache)
        .loadJSONData()
        .catch((err) => {
          console.error(err)
          console.error('Failed to load a storage JSON File: %s', cache)
          return null
        })
    })
  }

  let fetchNotes = function (storages) {
    let notes = []
    let modifiedStorages = []
    storages
      .forEach((storage) => {
        storage.data.folders.forEach((folder) => {
          let dataPath = path.join(storage.cache.path, folder.key, 'data.json')
          let data
          try {
            data = CSON.readFileSync(dataPath)
          } catch (e) {
            // Remove folder if fetching failed.
            console.error('Failed to load data: %s', dataPath)
            storage.data.folders = storage.data.folders.filter((_folder) => _folder.key !== folder.key)
            if (modifiedStorages.some((modified) => modified.key === storage.key)) modifiedStorages.push(storage)
            return
          }
          data.notes.forEach((note) => {
            note.storage = storage.key
            note.folder = folder.key
            notes.push(Note.forge(note))
          })
        })
      }, [])
    return Promise
      .all(modifiedStorages.map((storage) => storage.saveData()))
      .then(() => Promise.all(notes))
  }

  return Promise.all(fetchStorages())
    .then((_storages) => {
      storages = _storages.filter((storage) => {
        if (!_.isObject(storage)) return false
        return true
      })
      _saveCaches()

      return storages
    })
    .then(fetchNotes)
    .then((_notes) => {
      notes = _notes
      return {
        storages: storages.map((storage) => storage.toJSON()),
        notes: notes.map((note) => note.toJSON())
      }
    })
}

function _saveCaches () {
  localStorage.setItem('storages', JSON.stringify(storages.map((storage) => storage.cache)))
}

function addStorage (input) {
  if (!_.isString(input.path) || !input.path.match(/^\//)) {
    return Promise.reject(new Error('Path must be absolute.'))
  }

  let key = keygen()
  while (storages.some((storage) => storage.key === key)) {
    key = keygen()
  }

  return Storage
    .forge({
      name: input.name,
      key: key,
      type: input.type,
      path: input.path
    })
    .initStorage()
    .then((storage) => {
      let _notes = []
      let isFolderRemoved = false
      storage.data.folders.forEach((folder) => {
        let dataPath = path.join(storage.cache.path, folder.key, 'data.json')
        let data
        try {
          data = CSON.readFileSync(dataPath)
        } catch (e) {
          // Remove folder if fetching failed.
          console.error('Failed to load data: %s', dataPath)
          storage.data.folders = storage.data.folders.filter((_folder) => _folder.key !== folder.key)
          isFolderRemoved = true
          return true
        }
        data.notes.forEach((note) => {
          note.storage = storage.key
          note.folder = folder.key
          _notes.push(Note.forge(note))
        })

        notes = notes.slice().concat(_notes)
      })

      return Promise.all(notes)
        .then((notes) => {
          let data = {
            storage: storage,
            notes: notes
          }
          return isFolderRemoved
            ? storage.saveData().then(() => data)
            : data
        })
    })
    .then((data) => {
      storages = storages.filter((storage) => storage.key !== data.storage.key)
      storages.push(data.storage)
      _saveCaches()
      return {
        storage: data.storage.toJSON(),
        notes: data.notes.map((note) => note.toJSON())
      }
    })
}

function removeStorage (key) {
  storages = storages.filter((storage) => storage.key !== key)
  _saveCaches()
  notes = notes.filter((note) => note.storage !== key)
  return Promise.resolve(true)
}

function createFolder (key, input) {
  let storage = _.find(storages, {key: key})
  if (storage == null) throw new Error('Storage doesn\'t exist.')

  let folderKey = keygen()
  while (storage.data.folders.some((folder) => folder.key === folderKey)) {
    folderKey = keygen()
  }

  let newFolder = {
    key: folderKey,
    name: input.name,
    color: input.color
  }

  const defaultData = {notes: []}
  // FS MUST BE MANIPULATED BY ASYNC METHOD
  return sander
    .writeFile(path.join(storage.cache.path, folderKey, 'data.json'), JSON.stringify(defaultData))
    .then(() => {
      storage.data.folders.push(newFolder)
      return storage
        .saveData()
        .then((storage) => storage.toJSON())
    })
}

function updateFolder (storageKey, folderKey, input) {
  let storage = _.find(storages, {key: storageKey})
  if (storage == null) throw new Error('Storage doesn\'t exist.')
  let folder = _.find(storage.data.folders, {key: folderKey})
  folder.color = input.color
  folder.name = input.name

  return storage
    .saveData()
    .then((storage) => storage.toJSON())
}

function removeFolder (storageKey, folderKey) {
  let storage = _.find(storages, {key: storageKey})
  if (storage == null) throw new Error('Storage doesn\'t exist.')
  storage.data.folders = storage.data.folders.filter((folder) => folder.key !== folderKey)
  notes = notes.filter((note) => note.storage !== storageKey || note.folder !== folderKey)

  // FS MUST BE MANIPULATED BY ASYNC METHOD
  return sander
    .rimraf(path.join(storage.cache.path, folderKey))
    .catch((err) => {
      if (err.code === 'ENOENT') return true
      else throw err
    })
    .then(() => storage.saveData())
    .then((storage) => storage.toJSON())
}

function createMarkdownNote (storageKey, folderKey, input) {
  let key = keygen()
  while (notes.some((note) => note.storage === storageKey && note.folder === folderKey && note.key === key)) {
    key = keygen()
  }

  let newNote = new Note(Object.assign({
    tags: [],
    title: '',
    content: ''
  }, input, {
    type: 'MARKDOWN_NOTE',
    storage: storageKey,
    folder: folderKey,
    key: key,
    isStarred: false,
    createdAt: new Date(),
    updatedAt: new Date()
  }))
  notes.push(newNote)

  return newNote
    .save()
    .then(() => newNote.toJSON())
}

function createSnippetNote (storageKey, folderKey, input) {
  let key = keygen()
  while (notes.some((note) => note.storage === storageKey && note.folder === folderKey && note.key === key)) {
    key = keygen()
  }

  let newNote = new Note(Object.assign({
    tags: [],
    title: '',
    description: '',
    snippets: [{
      name: '',
      mode: 'text',
      content: ''
    }]
  }, input, {
    type: 'SNIPPET_NOTE',
    storage: storageKey,
    folder: folderKey,
    key: key,
    isStarred: false,
    createdAt: new Date(),
    updatedAt: new Date()
  }))
  notes.push(newNote)

  return newNote
    .save()
    .then(() => newNote.toJSON())
}

function updateNote (storageKey, folderKey, noteKey, input) {
  let note = _.find(notes, {
    key: noteKey,
    storage: storageKey,
    folder: folderKey
  })
  note.data.title = input.title
  note.data.tags = input.tags
  note.data.content = input.content
  note.data.updatedAt = input.updatedAt

  return note.save()
    .then(() => note.toJSON())
}

function removeNote (storageKey, folderKey, noteKey, input) {

}

export default {
  init,
  addStorage,
  removeStorage,
  createFolder,
  updateFolder,
  removeFolder,
  createMarkdownNote,
  createSnippetNote,
  updateNote,
  removeNote
}
