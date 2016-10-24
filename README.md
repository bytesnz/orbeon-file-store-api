Orbeon File Store API
====================

This Node.js server implements some of the basic functions of ORBEON's
[Persistence API](https://doc.orbeon.com/form-runner/api/persistence/) to allow
Orbeon Form Builder to store and publish the forms directly to files on the
file system, which allows them to be versioned in a version control system
(VCS) like Git.

When initially started, the server scans for form source files in the
specified folder and extracts form metadata from them. It then provides this
metadata to the Orbeon Form Builder form summary page so the forms can be
opened and edited. When the form is saved or published, source is written
directly to the file.
