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
  newId: newId
};

function randomString(length) {
    return Math.round((Math.pow(36, length + 1) - Math.random() * Math.pow(36, length))).toString(36).slice(1);
}

var watchFormRegex = new RegExp('([^\\' + path.sep + ']+)\\' + path.sep 
    + '([^\\' + path.sep + ']+)\.xhtml');
locks = {};
function watchEvent(eventType, filename) {
  log.verbose('Watcher event', eventType, filename);

  if (eventType === 'change') {
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

function buildFormData(app, form, formPath) {
  var stats;
  var id;
  return access(formPath, fs.R_OK | fs.W_OK).then(function() {
    // Read in the file so we can verify the app and name is the same
    return stat(formPath);
  }).then(function(fileStats) {
    stats = fileStats;

    // Check if file is already up-to-date (same mtime)
    if ((id = getFormId(app, form))) {
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
        console.error('metadata does not match for ', app, form);
        return Promise.reject(new Error('metadata does not match for file ' + formPath));
      }

      // Check if we have a map for the file
      if (!id) {
        /*id = app + '-' + form
            + (options.storeVersions && metadata['form-version']
            ? '-' + metadata['form-version'] : '');*/
        id = newId(40);
        setIdMapping(id, app, form);
      }

      log.verbose('saving info', id, app, form, formPath);

      // Add form to list
      formWatcher.forms[id] = {
        'application-name': app,
        'form-name': form,
        title: metadata['title'],
        description: metadata['description'],
        version: metadata['form-version'],
        file: formPath,
        btime: stats.birthtime,
        mtime: stats.mtime
      };

      setIdMapping(id, app, form);

      return Promise.resolve();
    });
  });
}

function refreshForms() {
  formWatcher.forms = {};

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
            // Check if the filename is *.xhtml
            if (file.match(/.*\.xhtml$/)) {
              var formPath = path.join(appPath, file);
              var form = file.replace(/\.xhtml$/, '');
              promises.push(buildFormData(app, form, formPath));
            }
          });

          return Promise.all(promises);
        }
      }).catch(function(err) {
      console.error(err.message, err.stack)
    }));
    });

    return Promise.all(promises);
  }).then(function() {
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
