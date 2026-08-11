/**
 * draggable-fab.js — make floating action buttons (the DM messenger toggle and the
 * global-chat FAB) drag-and-droppable.
 *
 *  • Position persists across page loads (localStorage per button).
 *  • Always clamped inside the viewport; if it ever ends up off-screen (a smaller
 *    window, a restored stale position), it springs back with a bounce.
 *  • Distinguishes a tap from a drag: a real drag past a small threshold suppresses
 *    the click that follows, so moving the button never opens its menu.
 *
 * Pointer Events based → one code path for mouse + touch.
 */
(function () {
    'use strict';

    var MARGIN = 10;          // keep this much gap from every viewport edge
    var DRAG_THRESHOLD = 6;   // px of movement before it counts as a drag (not a tap)

    // A single capture-phase click killer: cancels the click that fires right after a
    // drag, before it can reach the button's own onclick/handlers. Robust regardless of
    // handler registration order (which stopPropagation on the target could not guarantee).
    document.addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('.fab-just-dragged') : null;
        if (el) {
            e.stopPropagation();
            e.preventDefault();
            el.classList.remove('fab-just-dragged');
        }
    }, true);

    function makeFabDraggable(el, key) {
        if (!el || el._draggableInit) return;
        el._draggableInit = true;
        el.style.touchAction = 'none';

        var startX = 0, startY = 0, origX = 0, origY = 0;
        var dragging = false, moved = false, pid = null;

        function clamp(x, y) {
            var w = el.offsetWidth || 52;
            var h = el.offsetHeight || 52;
            var maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
            var maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
            return { x: Math.min(Math.max(MARGIN, x), maxX), y: Math.min(Math.max(MARGIN, y), maxY) };
        }

        function place(x, y) {
            el.style.left = x + 'px';
            el.style.top = y + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }

        function bounce() {
            el.classList.remove('fab-bounce');
            // reflow so the animation restarts if applied twice in a row
            void el.offsetWidth;
            el.classList.add('fab-bounce');
            setTimeout(function () { el.classList.remove('fab-bounce'); }, 500);
        }

        function save(x, y) {
            try { localStorage.setItem(key, JSON.stringify({ x: x, y: y })); } catch (_) {}
        }

        function restore() {
            var saved = null;
            try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) {}
            if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return;
            var c = clamp(saved.x, saved.y);
            var corrected = (Math.abs(c.x - saved.x) > 1 || Math.abs(c.y - saved.y) > 1);
            // Smoothly settle (with a bounce) if the saved spot was off-screen.
            if (corrected) {
                el.style.transition = 'left 0.42s cubic-bezier(.34,1.56,.64,1), top 0.42s cubic-bezier(.34,1.56,.64,1)';
                place(saved.x, saved.y);           // start from the stale spot...
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () { place(c.x, c.y); bounce(); });
                });
                setTimeout(function () { el.style.transition = ''; }, 480);
                save(c.x, c.y);
            } else {
                place(c.x, c.y);
            }
        }

        el.addEventListener('pointerdown', function (e) {
            if (e.button != null && e.button !== 0) return; // primary button / touch only
            pid = e.pointerId;
            var r = el.getBoundingClientRect();
            origX = r.left; origY = r.top;
            startX = e.clientX; startY = e.clientY;
            dragging = true; moved = false;
            el.style.transition = '';
            try { el.setPointerCapture(pid); } catch (_) {}
        });

        el.addEventListener('pointermove', function (e) {
            if (!dragging || e.pointerId !== pid) return;
            var dx = e.clientX - startX, dy = e.clientY - startY;
            if (!moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
            moved = true;
            el.classList.add('fab-dragging');
            var c = clamp(origX + dx, origY + dy);
            place(c.x, c.y);
            e.preventDefault();
        });

        function end(e) {
            if (!dragging || (e.pointerId != null && e.pointerId !== pid)) return;
            dragging = false;
            try { el.releasePointerCapture(pid); } catch (_) {}
            el.classList.remove('fab-dragging');
            if (moved) {
                var r = el.getBoundingClientRect();
                var c = clamp(r.left, r.top);
                if (Math.abs(c.x - r.left) > 1 || Math.abs(c.y - r.top) > 1) {
                    el.style.transition = 'left 0.42s cubic-bezier(.34,1.56,.64,1), top 0.42s cubic-bezier(.34,1.56,.64,1)';
                    place(c.x, c.y); bounce();
                    setTimeout(function () { el.style.transition = ''; }, 480);
                }
                save(c.x, c.y);
                // Kill the click that immediately follows this drag.
                el.classList.add('fab-just-dragged');
                setTimeout(function () { el.classList.remove('fab-just-dragged'); }, 400);
            }
        }
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);

        // If the window shrinks and the button falls off-screen, spring it back.
        window.addEventListener('resize', function () {
            if (el.style.left === '' || el.style.left == null) return; // still at CSS default anchor
            var r = el.getBoundingClientRect();
            var c = clamp(r.left, r.top);
            if (Math.abs(c.x - r.left) > 1 || Math.abs(c.y - r.top) > 1) {
                el.style.transition = 'left 0.42s cubic-bezier(.34,1.56,.64,1), top 0.42s cubic-bezier(.34,1.56,.64,1)';
                place(c.x, c.y); bounce();
                setTimeout(function () { el.style.transition = ''; }, 480);
                save(c.x, c.y);
            }
        });

        restore();
    }
    window.makeFabDraggable = makeFabDraggable;

    // Auto-wire the two known buttons. The FAB is static markup; the messenger toggle
    // is injected later by messenger.js — watch for it. (messenger.js also calls this
    // directly, but the observer covers any timing.)
    function tryInit() {
        var fab = document.getElementById('floating-chat-fab');
        if (fab) makeFabDraggable(fab, 'fabpos:floating-chat-fab');
        var toggle = document.getElementById('messenger-toggle');
        if (toggle) makeFabDraggable(toggle, 'fabpos:messenger-toggle');
        return !!(fab && toggle);
    }

    function boot() {
        if (tryInit()) return;
        // Keep watching until both exist (messenger toggle appears after auth/init).
        var obs = new MutationObserver(function () { if (tryInit()) { /* keep observing FAB re-adds is unnecessary */ } });
        obs.observe(document.body, { childList: true, subtree: false });
        // Stop watching after a while to avoid a permanent observer.
        setTimeout(function () { try { obs.disconnect(); } catch (_) {} }, 60000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
