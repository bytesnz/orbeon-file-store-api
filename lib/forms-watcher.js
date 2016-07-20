var fs = require('fs');
var Promise = require('promise');
var xml2js = require('xml2js');
var path = require('path');
var util = require('util');
var JSONPath = require('jsonpath-plus');
var log = require('npmlog');

var access = Promise.denodeify(fs.access);
var stat = Promise.denodeify(fs.stat);
var readdir = Promise.denodeify(fs.readdir);
var parseString = Promise.denodeify(xml2js.parseString);
var readFile = Promise.denodeify(fs.readFile);

require('promise/lib/rejection-tracking').enable();

function extractMetadata(xml) {
  return parseString(xml).then(function(xml) {
    // Hack find metadata
    var metadata = JSONPath({
      json: xml,
      path: '$..metadata'
    })[0][0];

    // Removed array
    Object.keys(metadata).forEach(function(key) {
      metadata[key] = metadata[key][0];
      if (metadata[key] instanceof Object) {
        metadata[key] = metadata[key]['_'];
      }
    });

    return Promise.resolve(metadata);
  });
}

var maps = {};

function getFormId(app, form) {
  if (maps[app]) {
    if (form) {
      return maps[app][form];
    } else {
      return maps[apps];
    }
  }
  return undefined;
}

function deleteMapping(app, form) {
  if (maps[app]) {
    if (form) {
      delete maps[app][form];
      if (!Object.keys(maps[app]).length) {
        delete maps[app];
      }
      return true;
    }
  }
  return false;
}

function setIdMapping(id, app, form) {
  if (!maps[app]) {
    maps[app] = {};
  }

  maps[app][form] = id;
}

var formWatcher;

function newId() {
  var id;

  while ((id = randomString(40))
    && typeof formWatcher.forms[id] !== 'undefined');

  return id;
}

formWatcher = {
  forms: {},
  extractMetadata: extractMetadata,
  getFormId: getFormId,
  setIdMapping: setIdMapping,
  deleteMapping: deleteMapping,
  newId: newId
};

function randomString(length) {
    return Math.round((Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))).toString(36).slice(1);
}

var watchFormRegex = new RegExp('([^\\' + path.sep + ']+)\\' + path.sep 
    + '([^\\' + path.sep + ']+)\.xhtml');
locks = {};
/**
 * Handles watch events on the src folder.
 * Edits on files are given as change <filename>
 * Creates are given as rename <filename> and change <directory>
 * Deletes are given as rename null and change <directory>
 * Deletes in the src folder are given as rename null
 * Renames are given as rename <newfilename>, change <directory> and
 *   change <newfilename>
 *
 * So, if we receive a:
 * - rename null, check all files are still there
 * - rename <filename> check if matches app/form.xhtml, then run buildFormData
 * - change <filename> check if matches app/form.xhtml, then run buildFormData
 *
 * @param {String} eventType Watch event type
 * @param {String} filename File/folder event relates to
 *
 * @returns {undefined}
 */
function watchEvent(eventType, filename) {
  log.verbose('watchEvent', eventType, filename);

  if (eventType === 'rename' && filename === null) {
    log.verbose('watchEvent',
        'Detected folder change, checking all forms exist');
    return refreshForms(true);
  } else {
    // Extract data from the file name
    var matches;

    if (!locks[filename]) {
      if ((matches = watchFormRegex.exec(filename)) !== null) {
        var app = matches[1];
        var form = matches[2];
        var filePath = path.join(options.srcFolder, filename);

        // "Lock" the file form processing
        locks[filename] = true;

        return buildFormData(app, form, filePath).then(function() {
          delete locks[filename];
          return Promise.resolve();
        }, function(err) {
          delete locks[filename];
          return Promise.reject(err);
        });
      }
    } else {
      log.verbose(filename, 'already being processed');
    }
  }
}

/** Builds and updates form data to be stored in forms.
 *
 * @param {String} app Application id (application-name)
 * @param {String} form Form id (form-name)
 * @param {String} formPath Path to form src file
 * @param {Boolean} noStore If truey, it will not store it in forms and
 *   create a mapping. If falsey, if it will only build and update the data
 *   if it is not already stored or if it's not up-to-date.
 *
 * @returns {Promise} A promise that will resolve to the form data
 */
function buildFormData(app, form, formPath, noStore) {
  var stats;
  var id;
  return access(formPath, fs.R_OK | fs.W_OK).then(function() {
    // Read in the file so we can verify the app and name is the same
    return stat(formPath);
  }).then(function(fileStats) {
    stats = fileStats;

    // Check if file is already up-to-date (same mtime)
    if (!noStore && (id = getFormId(app, form))) {
      if (formWatcher.forms[id]
          && stats.mtime.getTime() === formWatcher.forms[id].mtime.getTime()) {
        log.verbose(formPath, 'already up-to-date');
        return Promise.resolve();
      }
    }

    return readFile(formPath).then(function(xml) {
      return extractMetadata(xml);
    }).then(function(metadata) {
      log.silly('parsed file metadata',
          util.inspect(metadata, { depth: null }));

      // Verify the name is correct
      if (metadata['application-name'] !== app
          || metadata['form-name'] !== (form
          + (options.storeVersions && metadata['form-version']
          ? '-' + metadata['form-version'] : ''))) {
        log.error('metadata does not match for ', app, form);
        return Promise.reject(new Error('metadata does not match for file '
            + formPath));
      }

      // Check if we have a map for the file
      if (!id) {
        /*id = app + '-' + form
            + (options.storeVersions && metadata['form-version']
            ? '-' + metadata['form-version'] : '');*/
        id = newId(40);
      }

      // Add form to list
      var formData = {
        'application-name': app,
        'form-name': form,
        title: metadata['title'],
        description: metadata['description'],
        version: metadata['form-version'],
        file: formPath,
        btime: stats.birthtime,
        mtime: stats.mtime
      };

      if (!noStore) {
        log.verbose('saving info', id, app, form, formPath);

        formWatcher.forms[id] = formData;
        setIdMapping(id, app, form);
      }

      return Promise.resolve(formData);
    });
  });
}

/**@internal
 * Refreshes the forms store of forms
 *
 * @param {Boolean} [noUpdate] If true, will not update metadata if the form
 *   exists already
 *
 * @returns {Promise}
 */
function refreshForms(noUpdate) {
  //formWatcher.forms = {};
  var newForms = {}

  log.silly('refreshForms', (noUpdate ? 'Refreshing forms'
      : '(Re)loading forms'));

  return access(options.srcFolder, fs.R_OK).then(function goodSrcAccess() {
    return readdir(options.srcFolder);
  }).then(function handleApps(files) {
    var promises = [];

    // Iterate through potential app folders
    files.forEach(function (app) {
      var appPath = path.join(options.srcFolder, app);
      // Check permission first
      promises.push(access(appPath, fs.R_OK | fs.W_OK).then(function() {
        return stat(appPath);
      }).then(function(stat) {
        if (stat.isDirectory()) {
          return readdir(appPath);
        } else {
          log.warn('Ignoring file', app);
          return Promise.resolve();
        }
      }).then(function(files) {
        if (files) {
          var promises = [];

          files.forEach(function(file) {
            var id;

            // Check if the filename is *.xhtml
            if (file.match(/.*\.xhtml$/)) {
              var formPath = path.join(appPath, file);
              var form = file.replace(/\.xhtml$/, '');
              // If not refreshing metadata, check if file already exists
              if (noUpdate && (id = getFormId(app, form))) {
                // Copy it over
                log.silly('refreshForms', app + '/' + form, 'still there');
                newForms[id] = formWatcher.forms[id];
                delete formWatcher.forms[id];
              } else {
                promises.push(buildFormData(app, form, formPath, true)
                    .then(function(formData) {
                  if (formData) {
                    var id;
                    if (!(id = getFormId(app, form))) {
                      id = newId();
                      log.silly('refreshForms', 'creating id', id, 'for',
                          app, form);
                      setIdMapping(id, app, form);
                    }

                    newForms[id] = formData;
                  }

                  return Promise.resolve();
                }));
              }
            }
          });

          return Promise.all(promises);
        }

        return Promise.resolve();
      }).catch(function(err) {
      log.error(err.message, err.stack)
    }));
    });

    return Promise.all(promises);
  }).then(function() {
    log.verbose('refreshForms', 'Finished refreshing forms');
    // TODO add test for if log level is above verbose
    if (noUpdate && Object.keys(formWatcher.forms).length) {
      log.verbose('refreshForms', 'The following forms have been removed:');
      Object.keys(formWatcher.forms).forEach(function(id) {
        log.verbose('refreshForms', ' ', 
            formWatcher.forms[id]['application-name']
            + '/' + formWatcher.forms[id]['form-name']);
      });
    }
    formWatcher.forms = newForms;
    return Promise.resolve();
  });
}

module.exports = function setupFormList(givenOptions) {
  options = givenOptions;

  return new Promise(function(resolve, reject) {
    if (typeof options !== 'object') {
      reject(new Error('options must be given and an Object'));
      return;
    }

    if (typeof options.srcFolder !== 'string') {
      reject(new Error('options.srcFolder must be set and must be a path '
          + 'to the folder containing the draft forms'));
      return;
    }

    // Get the current forms by doing a directory sweep
    refreshForms().then(function() {

      // Set up a folder watcher
      fs.watch(options.srcFolder, {
        recursive: true
      }, watchEvent);

      resolve(formWatcher);
    });
  });
};
