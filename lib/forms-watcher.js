var fs = require('fs');
var Promise = require('promise');
var xml2js = require('xml2js');
var path = require('path');
var util = require('util');
var JSONPath = require('jsonpath-plus');

var access = Promise.denodeify(fs.access);
var stat = Promise.denodeify(fs.stat);
var readdir = Promise.denodeify(fs.readdir);
var parseString = Promise.denodeify(xml2js.parseString);
var readFile = Promise.denodeify(fs.readFile);

require('promise/lib/rejection-tracking').enable();

var formWatcher = {
  forms: {}
};

function watchEvent(eventType, filename) {
  console.log('Watcher event', eventType, filename);
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
          console.log('Ignoring file', app);
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
              promises.push(access(formPath, fs.R_OK | fs.W_OK).then(function() {
                // Read in the file so we can verify the app and name is the same
                return Promise.all([
                  stat(formPath),
                  readFile(formPath).then(function(buffer) {
                    return parseString(buffer);
                  })
                ]);
              }).then(function(data) {
                var stat = data.shift();
                var xml = data.shift();

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

                //console.log('parsed file metadata', util.inspect(metadata, { depth: null }));

                // Verify the name is correct
                if (metadata['application-name'] !== app
                    || metadata['form-name'] !== (form
                    + (options.storeVersions && metadata['form-version']
                    ? '-' + metadata['form-version'] : ''))) {
                  console.error('metadata does not match for ', app, form);
                  return Promise.reject(new Error('metadata does not match for file ' + formPath));
                }

                var id = app + '-' + form
                    + (options.storeVersions && metadata['form-version']
                    ? '-' + metadata['form-version'] : '');

                // Add form to list
                formWatcher.forms[id] = {
                  app: app,
                  form: form,
                  title: metadata['title'],
                  description: metadata['description'],
                  version: metadata['form-version'],
                  btime: stat.birthtime,
                  mtime: stat.mtime
                };

                return Promise.resolve();
              }));
            }
          });

          return Promise.all(promises);
        }
      }).catch(function(err) {
      console.error(err.message, err.stack)
    }));
    });

    console.log('returning promise');

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
