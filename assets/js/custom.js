/**
 * Main JS file for theme behaviours
 */
(function () {
	"use strict";
	document.addEventListener('DOMContentLoaded', function () {
		// Scroll to top
		document.getElementById('top-button').addEventListener('click', function (e) {
			skrollTop.scrollTo({
				to: 0
			});
			e.preventDefault();
		});

		// Sidebar
		document.querySelectorAll('#sidebar-show, #sidebar-hide').forEach(function (el) {
			el.addEventListener('click', function (e) {
				document.body.classList.toggle('sidebar--opened');
				this.blur();
				e.preventDefault();
			})
		});

		document.getElementById('site-overlay').addEventListener('click', function (e) {
			document.body.classList.remove('sidebar--opened');
			e.preventDefault();
		});

		// Show comments
		var interval = setInterval(function () {
			var disqusHeight = document.getElementById('disqus_thread').offsetHeight;
			if (disqusHeight > 100) {
				document.getElementById('comments-area').classList.add('comments--loaded');
				clearInterval(interval);
			}
		}, 100);

		document.querySelectorAll('#comments-overlay, #comments-show').forEach(function (el) {
			el.addEventListener('click', function (e) {
				document.getElementById('comments-area').classList.remove('comments--loaded');
				document.getElementById('comments-area').classList.add('comments--opened');
				e.preventDefault();
			});
		});
	});
}());
