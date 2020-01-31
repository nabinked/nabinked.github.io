---
layout: post
title: 'Installing Multiple Versions of Node.js Using NVM'
tags: [JavaScript, Tips, Node]
featured_image_thumbnail: assets/images/posts/2018/2_thumbnail.jpg
featured_image: assets/images/posts/2018/2.jpg
---

**Node.js** is an open-source, cross-platform JavaScript run-time environment for executing JavaScript code server-side. Historically, JavaScript was used primarily for client-side scripting, in which scripts written in JavaScript are embedded in a webpage's HTML, to be run client-side by a JavaScript engine in the user's web browser.

<!--more-->

Node.js enables JavaScript to be used for server-side scripting, and runs scripts server-side to produce dynamic web page content before the page is sent to the user's web browser.

Consequently, Node.js has become one of the foundational elements of the **"JavaScript everywhere"** paradigm, allowing web application development to unify around a single programming language, rather than rely on a different language for writing server side scripts.

> “Computer science education cannot make anybody an expert programmer any more than studying brushes and pigment can make somebody an expert painter.”
> <cite>- Eric S. Raymond -</cite>

Though .js is the conventional filename extension for JavaScript code, the name "Node.js" does not refer to a particular file in this context and is merely the name of the product. Node.js has an event-driven architecture capable of asynchronous I/O. These design choices aim to optimize throughput and scalability in Web applications with many input/output operations, as well as for real-time Web applications (e.g., real-time communication programs and browser games).

The Node.js distributed development project, governed by the Node.js Foundation, is facilitated by the Linux Foundation's Collaborative Projects program.

Corporate users of Node.js software include IBM, LinkedIn, Microsoft, Netflix, PayPal, Rakuten, SAP, Voxer and Yahoo!.

##History

Node.js was originally written by [Ryan Dahl](https://en.wikipedia.org/wiki/Ryan_Dahl) in 2009, about thirteen years after the introduction of the first server-side JavaScript environment, Netscape's LiveWire Pro Web. The initial release supported only Linux and Mac OS X. Its development and maintenance was led by Dahl and later sponsored by Joyent.

Dahl was inspired to create Node.js after seeing a file upload progress bar on Flickr. The browser did not know how much of the file had been uploaded and had to query the Web server. Dahl desired an easier way.

Dahl criticized the limited possibilities of the most popular web server in 2009, Apache HTTP Server, to handle a lot of concurrent connections (up to 10,000 and more) and the most common way of creating code (sequential programming), when code either blocked the entire process or implied multiple execution stacks in the case of simultaneous connections.

Dahl demonstrated the project at the inaugural European JSConf on November 8, 2009. Node.js combined Google's V8 JavaScript engine, an event loop, and a low-level I/O API.

In January 2010, a package manager was introduced for the Node.js environment called npm. The package manager makes it easier for programmers to publish and share source code of Node.js libraries and is designed to simplify installation, updating, and uninstallation of libraries.

In June 2011, Microsoft and Joyent implemented a native Windows version of Node.js. The first Node.js build supporting Windows was released in July 2011.

In January 2012, Dahl stepped aside, promoting coworker and npm creator Isaac Schlueter to manage the project. In January 2014, Schlueter announced that Timothy J. Fontaine would lead the project.

In December 2014, Fedor Indutny started io.js, a fork of Node.js. Due to the internal conflict over Joyent's governance, io.js was created as an open governance alternative with a separate technical committee. Unlike Node.js, the authors planned to keep io.js up-to-date with the latest releases of the Google V8 JavaScript engine.

In February 2015, the intent to form a neutral Node.js Foundation was announced. By June 2015, the Node.js and io.js communities voted to work together under the Node.js Foundation.

In September 2015, Node.js v0.12 and io.js v3.3 were merged back together into Node v4.0. This brought V8 ES6 features into Node.js, and a long-term support release cycle. As of 2016, the io.js website recommends that developers switch back to Node.js and that no further releases of io.js are planned due to the merger.
