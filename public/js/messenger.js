/* ═══════════════════════════════════════════════════════════════
   HoboStreamer — Messenger Widget (Facebook Messenger-style DMs)
   Floating widget accessible across the whole platform.
   Uses the /api/dm/* REST endpoints + real-time WS delivery.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────
    let panelOpen = false;
    let view = 'inbox';           // 'inbox' | 'thread' | 'new' | 'group-info'
    let conversations = [];
    let activeConvId = null;
    let activeConv = null;
    let threadMessages = [];
    let hasMoreMessages = true;
    let searchResults = [];
    let selectedUsers = [];
    let unreadTotal = 0;
    let pollTimer = null;
    let searchDebounce = null;

    // ── DOM refs (set once in init) ──────────────────────────────
    let $toggle, $badge, $panel;

    // ── Helpers ──────────────────────────────────────────────────
    function esc(s) {
        if (s == null) return '';
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
        const diff = (Date.now() - d.getTime()) / 1000;
        if (diff < 60) return 'now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd';
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function formatMessageTime(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    function formatDateSep(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return 'Today';
        const y = new Date(now); y.setDate(y.getDate() - 1);
        if (d.toDateString() === y.toDateString()) return 'Yesterday';
        return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    }

    function avatarHtml(user, size = 42) {
        if (!user) return `<div class="msg-conv-avatar" style="width:${size}px;height:${size}px"><i class="fa-solid fa-user"></i></div>`;
        if (user.avatar_url) {
            return `<div class="msg-conv-avatar" style="width:${size}px;height:${size}px">
                <img src="${esc(user.avatar_url)}" alt="" onerror="this.parentElement.innerHTML='<span style=\\'background:${esc(user.profile_color || '#999')}\\';font-size:${Math.round(size*0.4)}px>${esc((user.display_name||user.username||'?')[0].toUpperCase())}</span>'">
            </div>`;
        }
        const color = user.profile_color || '#999';
        const initial = (user.display_name || user.username || '?')[0].toUpperCase();
        return `<div class="msg-conv-avatar" style="width:${size}px;height:${size}px;background:${esc(color)};font-size:${Math.round(size*0.4)}px">${esc(initial)}</div>`;
    }

    function groupAvatarHtml(conv, size = 42) {
        return `<div class="msg-conv-avatar group" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.45)}px"><i class="fa-solid fa-users"></i></div>`;
    }

    function getConvName(conv) {
        if (conv.name) return conv.name;
        if (conv.is_group) {
            const names = (conv.participants || [])
                .filter(p => p.id !== currentUser?.id)
                .map(p => p.display_name || p.username)
                .slice(0, 3);
            return names.join(', ') || 'Group';
        }
        const other = (conv.participants || []).find(p => p.id !== currentUser?.id);
        return other ? (other.display_name || other.username) : 'Chat';
    }

    function getConvOther(conv) {
        if (conv.is_group) return null;
        return (conv.participants || []).find(p => p.id !== currentUser?.id) || null;
    }

    // ── API ──────────────────────────────────────────────────────
    async function dmApi(path, opts = {}) {
        return api(`/dm${path}`, opts);
    }

    // ── Inject HTML ──────────────────────────────────────────────
    function injectWidget() {
        // Toggle button
        $toggle = document.createElement('button');
        $toggle.className = 'messenger-toggle';
        $toggle.id = 'messenger-toggle';
        $toggle.innerHTML = '<i class="fa-solid fa-comment-dots"></i><span class="msg-badge" id="msg-badge"></span>';
        $toggle.addEventListener('click', togglePanel);
        document.body.appendChild($toggle);

        $badge = document.getElementById('msg-badge');

        // Panel
        $panel = document.createElement('div');
        $panel.className = 'messenger-panel';
        $panel.id = 'messenger-panel';
        document.body.appendChild($panel);

        renderInbox();
    }

    // ── Toggle ───────────────────────────────────────────────────
    function togglePanel() {
        panelOpen = !panelOpen;
        $panel.classList.toggle('open', panelOpen);
        if (panelOpen) {
            view = 'inbox';
            loadConversations();
        }
    }

    function closePanel() {
        panelOpen = false;
        $panel.classList.remove('open');
    }

    // ── Render: Inbox ────────────────────────────────────────────
    function renderInbox() {
        view = 'inbox';
        $panel.innerHTML = `
            <div class="msg-header">
                <span class="msg-header-title">Messages</span>
                <div class="msg-header-actions">
                    <button class="msg-header-btn" id="msg-new-btn" title="New message"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button class="msg-header-btn" id="msg-close-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="msg-inbox" id="msg-inbox"></div>
        `;
        document.getElementById('msg-new-btn').addEventListener('click', showNewMessage);
        document.getElementById('msg-close-btn').addEventListener('click', closePanel);
        renderConversationList();
    }

    function renderConversationList() {
        const inbox = document.getElementById('msg-inbox');
        if (!inbox) return;
        if (!conversations.length) {
            inbox.innerHTML = `<div class="msg-inbox-empty"><i class="fa-solid fa-comment-dots"></i><span>No messages yet</span><span style="font-size:12px;color:var(--text-muted)">Start a conversation!</span></div>`;
            return;
        }
        inbox.innerHTML = conversations.map(conv => {
            const other = getConvOther(conv);
            const avatar = conv.is_group ? groupAvatarHtml(conv) : avatarHtml(other);
            const name = esc(getConvName(conv));
            const preview = conv.last_message ? esc(conv.last_message.length > 45 ? conv.last_message.slice(0, 45) + '…' : conv.last_message) : '<i>No messages</i>';
            const time = timeAgo(conv.last_message_at || conv.updated_at);
            const unreadBadge = conv.unread_count > 0 ? `<span class="msg-conv-unread">${conv.unread_count}</span>` : '';
            const unreadClass = conv.unread_count > 0 ? ' unread' : '';
            return `<div class="msg-conv-item${unreadClass}" data-conv-id="${conv.id}">
                ${avatar}
                <div class="msg-conv-body">
                    <div class="msg-conv-name">${name}</div>
                    <div class="msg-conv-preview">${preview}</div>
                </div>
                <div class="msg-conv-meta">
                    <span class="msg-conv-time">${time}</span>
                    ${unreadBadge}
                </div>
            </div>`;
        }).join('');

        inbox.querySelectorAll('.msg-conv-item').forEach(el => {
            el.addEventListener('click', () => openThread(parseInt(el.dataset.convId)));
        });
    }

    // ── Render: Thread ───────────────────────────────────────────
    function renderThread() {
        view = 'thread';
        const conv = activeConv;
        const name = esc(getConvName(conv));
        const isGroup = conv.is_group;

        $panel.innerHTML = `
            <div class="msg-header">
                <button class="msg-header-btn" id="msg-back-btn" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <span class="msg-header-title">${name}</span>
                <div class="msg-header-actions">
                    ${isGroup ? `<button class="msg-header-btn" id="msg-info-btn" title="Group info"><i class="fa-solid fa-circle-info"></i></button>` : ''}
                    <button class="msg-header-btn" id="msg-close-btn2" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="msg-thread" id="msg-thread"></div>
            <div class="msg-compose">
                <input type="text" id="msg-compose-input" placeholder="Type a message..." maxlength="2000" autocomplete="off">
                <button class="msg-send-btn" id="msg-send-btn"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
        `;

        document.getElementById('msg-back-btn').addEventListener('click', () => { renderInbox(); loadConversations(); });
        document.getElementById('msg-close-btn2').addEventListener('click', closePanel);
        if (isGroup) document.getElementById('msg-info-btn')?.addEventListener('click', showGroupInfo);

        const input = document.getElementById('msg-compose-input');
        const sendBtn = document.getElementById('msg-send-btn');
        input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
        sendBtn.addEventListener('click', sendMessage);

        renderMessages();
        input.focus();
    }

    function renderMessages() {
        const thread = document.getElementById('msg-thread');
        if (!thread) return;
        if (!threadMessages.length) {
            thread.innerHTML = '<div class="msg-thread-empty">No messages yet. Say hi!</div>';
            return;
        }

        // Messages come newest-first from API; render oldest-first
        const sorted = [...threadMessages].sort((a, b) => a.id - b.id);
        let html = '';

        if (hasMoreMessages && sorted.length >= 50) {
            html += '<div class="msg-load-more"><button id="msg-load-more-btn">Load older messages</button></div>';
        }

        let lastDate = '';
        for (const msg of sorted) {
            const msgDate = formatDateSep(msg.created_at);
            if (msgDate !== lastDate) {
                html += `<div class="msg-date-sep">${msgDate}</div>`;
                lastDate = msgDate;
            }
            const isSelf = msg.sender_id === currentUser?.id;
            const side = isSelf ? 'self' : 'other';
            const sender = isSelf ? currentUser : { username: msg.username, display_name: msg.display_name, avatar_url: msg.avatar_url, profile_color: msg.profile_color };
            const showSender = activeConv?.is_group && !isSelf;

            html += `<div class="msg-bubble-row ${side}">
                ${!isSelf ? avatarHtml(sender, 26).replace('msg-conv-avatar', 'msg-bubble-avatar') : ''}
                <div class="msg-bubble">
                    ${showSender ? `<div class="msg-bubble-sender">${esc(msg.display_name || msg.username)}</div>` : ''}
                    <div class="msg-bubble-text">${esc(msg.message)}</div>
                    <div class="msg-bubble-time">${formatMessageTime(msg.created_at)}</div>
                </div>
            </div>`;
        }
        thread.innerHTML = html;

        // Scroll to bottom
        thread.scrollTop = thread.scrollHeight;

        // Load more button
        const loadMoreBtn = document.getElementById('msg-load-more-btn');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', loadOlderMessages);
        }
    }

    // ── Render: New Message ──────────────────────────────────────
    function showNewMessage() {
        view = 'new';
        selectedUsers = [];
        searchResults = [];

        $panel.innerHTML = `
            <div class="msg-header">
                <button class="msg-header-btn" id="msg-back-btn3" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <span class="msg-header-title">New Message</span>
                <div class="msg-header-actions">
                    <button class="msg-header-btn" id="msg-close-btn3" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="msg-search-view">
                <div class="msg-search-selected" id="msg-selected-chips"></div>
                <div class="msg-search-input-wrap">
                    <input type="text" id="msg-user-search" placeholder="Search users..." autocomplete="off">
                </div>
                <div class="msg-search-results" id="msg-search-results"></div>
                <div class="msg-search-actions">
                    <button id="msg-start-chat-btn" disabled>Start Conversation</button>
                </div>
            </div>
        `;

        document.getElementById('msg-back-btn3').addEventListener('click', () => { renderInbox(); loadConversations(); });
        document.getElementById('msg-close-btn3').addEventListener('click', closePanel);
        document.getElementById('msg-start-chat-btn').addEventListener('click', startConversation);

        const searchInput = document.getElementById('msg-user-search');
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => searchUsers(searchInput.value.trim()), 300);
        });
        searchInput.focus();
    }

    function renderSelectedChips() {
        const chips = document.getElementById('msg-selected-chips');
        if (!chips) return;
        chips.innerHTML = selectedUsers.map(u =>
            `<span class="msg-search-chip" data-uid="${u.id}">${esc(u.display_name || u.username)} <span class="remove-chip" data-uid="${u.id}">&times;</span></span>`
        ).join('');
        chips.querySelectorAll('.remove-chip').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                selectedUsers = selectedUsers.filter(u => u.id !== parseInt(el.dataset.uid));
                renderSelectedChips();
                updateStartBtn();
            });
        });
    }

    function renderSearchResults() {
        const container = document.getElementById('msg-search-results');
        if (!container) return;
        if (!searchResults.length) {
            const q = document.getElementById('msg-user-search')?.value?.trim();
            container.innerHTML = q ? '<div class="msg-inbox-empty" style="padding:24px"><span>No users found</span></div>' : '';
            return;
        }
        container.innerHTML = searchResults
            .filter(u => !selectedUsers.find(s => s.id === u.id))
            .map(u => `<div class="msg-user-item" data-uid="${u.id}">
                ${avatarHtml(u, 36)}
                <div>
                    <div class="msg-user-item-name">${esc(u.display_name || u.username)}</div>
                    <div class="msg-user-item-sub">@${esc(u.username)}</div>
                </div>
            </div>`).join('');
        container.querySelectorAll('.msg-user-item').forEach(el => {
            el.addEventListener('click', () => {
                const uid = parseInt(el.dataset.uid);
                const user = searchResults.find(u => u.id === uid);
                if (user && !selectedUsers.find(s => s.id === uid)) {
                    selectedUsers.push(user);
                    renderSelectedChips();
                    renderSearchResults();
                    updateStartBtn();
                }
            });
        });
    }

    function updateStartBtn() {
        const btn = document.getElementById('msg-start-chat-btn');
        if (btn) btn.disabled = selectedUsers.length === 0;
    }

    // ── Render: Group Info ───────────────────────────────────────
    function showGroupInfo() {
        view = 'group-info';
        const conv = activeConv;
        const participants = conv.participants || [];
        const isCreator = conv.created_by === currentUser?.id;

        $panel.innerHTML = `
            <div class="msg-header">
                <button class="msg-header-btn" id="msg-back-info" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <span class="msg-header-title">Group Info</span>
                <div class="msg-header-actions">
                    <button class="msg-header-btn" id="msg-close-info" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="msg-group-info">
                <input type="text" class="msg-group-name-input" id="msg-group-name" placeholder="Group name..." value="${esc(conv.name || '')}" maxlength="100">

                <div class="msg-group-section-title">Members (${participants.length})</div>
                ${participants.map(p => `<div class="msg-group-member">
                    ${avatarHtml(p, 32)}
                    <span class="msg-group-member-name">${esc(p.display_name || p.username)}${p.id === conv.created_by ? ' <small style="color:var(--text-muted)">(creator)</small>' : ''}</span>
                    ${isCreator && p.id !== currentUser?.id ? `<button class="msg-group-member-remove" data-uid="${p.id}" title="Remove"><i class="fa-solid fa-xmark"></i></button>` : ''}
                </div>`).join('')}

                <button class="msg-group-add-btn" id="msg-group-add"><i class="fa-solid fa-user-plus"></i> Add people</button>

                <div class="msg-group-leave">
                    <button id="msg-leave-group"><i class="fa-solid fa-right-from-bracket"></i> Leave group</button>
                </div>
            </div>
        `;

        document.getElementById('msg-back-info').addEventListener('click', () => openThread(activeConvId));
        document.getElementById('msg-close-info').addEventListener('click', closePanel);

        // Rename
        const nameInput = document.getElementById('msg-group-name');
        let renameTimeout = null;
        nameInput.addEventListener('input', () => {
            clearTimeout(renameTimeout);
            renameTimeout = setTimeout(async () => {
                try {
                    await dmApi(`/conversations/${activeConvId}`, { method: 'PATCH', body: { name: nameInput.value.trim() || null } });
                } catch { /* ignore */ }
            }, 600);
        });

        // Remove members
        document.querySelectorAll('.msg-group-member-remove').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = parseInt(btn.dataset.uid);
                try {
                    await dmApi(`/conversations/${activeConvId}/participants/${uid}`, { method: 'DELETE' });
                    activeConv.participants = activeConv.participants.filter(p => p.id !== uid);
                    showGroupInfo();
                } catch { toast('Failed to remove member', 'error'); }
            });
        });

        // Add people
        document.getElementById('msg-group-add').addEventListener('click', showAddToGroup);

        // Leave
        document.getElementById('msg-leave-group').addEventListener('click', async () => {
            try {
                await dmApi(`/conversations/${activeConvId}/participants/${currentUser.id}`, { method: 'DELETE' });
                toast('Left the group', 'info');
                activeConvId = null;
                activeConv = null;
                renderInbox();
                loadConversations();
            } catch { toast('Failed to leave group', 'error'); }
        });
    }

    function showAddToGroup() {
        // Reuse the search view but for adding to existing group
        view = 'new';
        selectedUsers = [];
        searchResults = [];

        $panel.innerHTML = `
            <div class="msg-header">
                <button class="msg-header-btn" id="msg-back-add" title="Back"><i class="fa-solid fa-arrow-left"></i></button>
                <span class="msg-header-title">Add People</span>
                <div class="msg-header-actions">
                    <button class="msg-header-btn" id="msg-close-add" title="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="msg-search-view">
                <div class="msg-search-selected" id="msg-selected-chips"></div>
                <div class="msg-search-input-wrap">
                    <input type="text" id="msg-user-search" placeholder="Search users..." autocomplete="off">
                </div>
                <div class="msg-search-results" id="msg-search-results"></div>
                <div class="msg-search-actions">
                    <button id="msg-add-to-group-btn" disabled>Add to Group</button>
                </div>
            </div>
        `;

        document.getElementById('msg-back-add').addEventListener('click', showGroupInfo);
        document.getElementById('msg-close-add').addEventListener('click', closePanel);

        const addBtn = document.getElementById('msg-add-to-group-btn');
        addBtn.addEventListener('click', async () => {
            for (const u of selectedUsers) {
                try {
                    await dmApi(`/conversations/${activeConvId}/participants`, { method: 'POST', body: { user_id: u.id } });
                } catch { /* ignore */ }
            }
            // Refresh conv
            try {
                const data = await dmApi(`/conversations/${activeConvId}`);
                activeConv = data.conversation;
            } catch { /* ignore */ }
            showGroupInfo();
        });

        const searchInput = document.getElementById('msg-user-search');
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => searchUsers(searchInput.value.trim()), 300);
        });
        searchInput.focus();

        // Override updateStartBtn for this context
        const origUpdate = updateStartBtn;
        window._msgUpdateStartBtn = () => {
            if (addBtn) addBtn.disabled = selectedUsers.length === 0;
        };
    }

    // ── API Actions ──────────────────────────────────────────────
    async function loadConversations() {
        try {
            const data = await dmApi('/conversations');
            conversations = data.conversations || [];
            renderConversationList();
        } catch {
            conversations = [];
            renderConversationList();
        }
    }

    async function loadUnread() {
        if (!currentUser) {
            unreadTotal = 0;
            updateBadge();
            return;
        }
        try {
            const data = await dmApi('/unread');
            unreadTotal = data.unread || 0;
        } catch {
            unreadTotal = 0;
        }
        updateBadge();
    }

    function updateBadge() {
        if (!$badge) return;
        $badge.textContent = unreadTotal > 0 ? (unreadTotal > 99 ? '99+' : String(unreadTotal)) : '';
        $badge.dataset.count = unreadTotal;
    }

    async function openThread(convId) {
        activeConvId = convId;
        threadMessages = [];
        hasMoreMessages = true;

        try {
            const [convData, msgData] = await Promise.all([
                dmApi(`/conversations/${convId}`),
                dmApi(`/conversations/${convId}/messages?limit=50`),
            ]);
            activeConv = convData.conversation;
            threadMessages = msgData.messages || [];
            hasMoreMessages = threadMessages.length >= 50;
        } catch {
            toast('Failed to load conversation', 'error');
            return;
        }

        renderThread();

        // Mark as read
        try {
            await dmApi(`/conversations/${convId}/read`, { method: 'POST' });
            // Update unread locally
            const conv = conversations.find(c => c.id === convId);
            if (conv) conv.unread_count = 0;
            loadUnread();
        } catch { /* ignore */ }
    }

    async function loadOlderMessages() {
        if (!activeConvId || !threadMessages.length) return;
        const oldest = threadMessages.reduce((min, m) => m.id < min ? m.id : min, threadMessages[0].id);
        try {
            const data = await dmApi(`/conversations/${activeConvId}/messages?limit=50&before=${oldest}`);
            const older = data.messages || [];
            if (older.length < 50) hasMoreMessages = false;
            threadMessages = [...threadMessages, ...older];
            const thread = document.getElementById('msg-thread');
            const scrollBefore = thread ? thread.scrollHeight : 0;
            renderMessages();
            // Preserve scroll position
            if (thread) thread.scrollTop = thread.scrollHeight - scrollBefore;
        } catch {
            toast('Failed to load messages', 'error');
        }
    }

    async function sendMessage() {
        const input = document.getElementById('msg-compose-input');
        if (!input) return;
        const text = input.value.trim();
        if (!text || !activeConvId) return;
        input.value = '';

        try {
            const data = await dmApi(`/conversations/${activeConvId}/messages`, {
                method: 'POST',
                body: { message: text },
            });
            if (data.message) {
                threadMessages.unshift(data.message);
                renderMessages();
            }
        } catch {
            toast('Failed to send message', 'error');
            input.value = text;
        }
    }

    async function searchUsers(q) {
        if (!q) { searchResults = []; renderSearchResults(); return; }
        try {
            const data = await dmApi(`/users/search?q=${encodeURIComponent(q)}`);
            searchResults = data.users || [];
            renderSearchResults();
        } catch {
            searchResults = [];
            renderSearchResults();
        }
    }

    async function startConversation() {
        if (!selectedUsers.length) return;
        try {
            const data = await dmApi('/conversations', {
                method: 'POST',
                body: { user_ids: selectedUsers.map(u => u.id) },
            });
            if (data.conversation) {
                await openThread(data.conversation.id);
            }
        } catch {
            toast('Failed to start conversation', 'error');
        }
    }

    // ── Real-time: handle incoming DM from WebSocket ─────────────
    function handleIncomingDm(data) {
        if (data.type === 'dm' && data.message) {
            const msg = data.message;
            // If currently viewing this thread, append it
            if (panelOpen && view === 'thread' && activeConvId === data.conversation_id) {
                threadMessages.unshift(msg);
                renderMessages();
                // Auto mark read
                dmApi(`/conversations/${data.conversation_id}/read`, { method: 'POST' }).catch(() => {});
            } else {
                // Bump unread
                unreadTotal++;
                updateBadge();
                // Update conversation list
                const conv = conversations.find(c => c.id === data.conversation_id);
                if (conv) {
                    conv.unread_count = (conv.unread_count || 0) + 1;
                    conv.last_message = msg.message;
                    conv.last_message_at = msg.created_at;
                    if (panelOpen && view === 'inbox') renderConversationList();
                }
            }
        } else if (data.type === 'dm-participant-added') {
            // Refresh conversation if we're viewing it
            if (panelOpen && activeConvId === data.conversation_id) {
                if (view === 'thread' || view === 'group-info') openThread(data.conversation_id);
            }
            if (panelOpen && view === 'inbox') loadConversations();
        }
    }

    // ── Public API (for chat.js to open a DM with a user) ────────
    window.openMessengerDm = async function (username) {
        if (!currentUser) { toast('Sign in to send messages', 'error'); return; }
        // Search for user by username
        try {
            const data = await dmApi(`/users/search?q=${encodeURIComponent(username)}`);
            const users = data.users || [];
            const target = users.find(u => u.username.toLowerCase() === username.toLowerCase());
            if (!target) { toast(`User "${username}" not found`, 'error'); return; }
            // Get or create 1-on-1 conversation
            const convData = await dmApi('/conversations', {
                method: 'POST',
                body: { user_ids: [target.id] },
            });
            if (convData.conversation) {
                if (!panelOpen) togglePanel();
                await openThread(convData.conversation.id);
            }
        } catch {
            toast('Failed to open DM', 'error');
        }
    };

    // ── Init ─────────────────────────────────────────────────────
    function init() {
        if (!document.body) return;
        injectWidget();

        // Poll unread every 30s
        loadUnread();
        pollTimer = setInterval(loadUnread, 30000);

        // Hook into chat WebSocket message handler
        // The chat.js `handleChatMessage` will call `handleIncomingDm` for DM type messages
        window._messengerHandleDm = handleIncomingDm;
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Expose for programmatic access
    window.messengerWidget = {
        open: () => { if (!panelOpen) togglePanel(); },
        close: closePanel,
        openDm: window.openMessengerDm,
    };
})();
