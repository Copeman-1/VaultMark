// Privacy Bookmarks - Main Popup Logic

class BookmarkManager {
  constructor() {
    this.currentTab = null;
    this.selectedBookmarks = new Set();
    this.expandedCategories = new Set();
    this.decryptedCache = new Map(); // Cache for decrypted bookmarks by category
    this.derivedKeys = new Map(); // Cache for derived encryption keys
    this.init();
  }

  async init() {
    await this.loadCurrentTab();
    this.setupEventListeners();
    this.loadSettings();
    this.loadDarkMode();
    this.loadBookmarks(); // Load bookmarks immediately on startup
  }

  async loadCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tab;
    
    document.getElementById('pageTitle').textContent = tab.title || 'Untitled';
    document.getElementById('pageUrl').textContent = new URL(tab.url).hostname;
  }

  setupEventListeners() {
    // Theme toggle
    document.getElementById('themeToggle').addEventListener('click', () => this.toggleDarkMode());
    
    // Settings
    document.getElementById('settingsBtn').addEventListener('click', () => this.showSettings());
    document.getElementById('closeSettings').addEventListener('click', () => this.hideSettings());
    document.getElementById('saveSettings').addEventListener('click', () => this.saveSettings());

    // Bookmark action
    document.getElementById('bookmarkBtn').addEventListener('click', () => this.bookmarkCurrentPage());

    // Manage bookmarks
    document.getElementById('selectAllBtn').addEventListener('click', () => this.selectAll());
    document.getElementById('deleteSelectedBtn').addEventListener('click', () => this.deleteSelected());
    document.getElementById('searchInput').addEventListener('input', (e) => this.searchBookmarks(e.target.value));
  }

  showSettings() {
    document.getElementById('settingsView').classList.remove('hidden');
  }

  hideSettings() {
    document.getElementById('settingsView').classList.add('hidden');
  }

  toggleDarkMode() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('darkMode', isDark ? 'true' : 'false');
    
    // Update theme toggle icon
    const themeBtn = document.getElementById('themeToggle');
    themeBtn.textContent = isDark ? '☀️' : '🌙';
  }

  loadDarkMode() {
    const isDark = localStorage.getItem('darkMode') === 'true';
    if (isDark) {
      document.body.classList.add('dark-mode');
      document.getElementById('themeToggle').textContent = '☀️';
    }
  }

  async loadSettings() {
    const data = await chrome.storage.local.get(['settings']);
    const settings = data.settings || {
      autoCreateCategories: true,
      defaultCategoryName: 'Uncategorized'
    };

    document.getElementById('autoCreateCategories').checked = settings.autoCreateCategories;
    document.getElementById('defaultCategory').value = settings.defaultCategoryName;
  }

  async saveSettings() {
    const settings = {
      autoCreateCategories: document.getElementById('autoCreateCategories').checked,
      defaultCategoryName: document.getElementById('defaultCategory').value
    };

    await chrome.storage.local.set({ settings });
    this.showSuccess('Settings saved!');
  }

  async bookmarkCurrentPage() {
    const url = this.currentTab.url;
    const title = this.currentTab.title;
    const domain = new URL(url).hostname;

    // Check if already bookmarked
    let data = await chrome.storage.local.get(['bookmarks', 'categories']);
    const bookmarks = data.bookmarks || [];
    
    if (bookmarks.some(b => b.url === url)) {
      this.showSuccess('Already bookmarked!');
      return;
    }

    // Get or create category
    const categoryId = await this.getOrCreateCategory(domain);
    
    // Re-fetch categories in case a new one was created
    data = await chrome.storage.local.get(['categories']);
    const categories = data.categories || [];
    const category = categories.find(c => c.id === categoryId);

    // Create bookmark
    let bookmark = {
      id: this.generateId(),
      url,
      title,
      domain,
      categoryId,
      createdAt: Date.now(),
      encrypted: false
    };

    // If category is password protected, encrypt the bookmark data
    if (category && category.password) {
      const password = prompt('This category is password-protected. Enter password to save bookmark:');
      if (!password) {
        return; // User cancelled
      }

      // Verify password
      const hashedInput = await this.hashPassword(password);
      if (hashedInput !== category.password) {
        alert('Incorrect password!');
        return;
      }

      // Encrypt bookmark data
      const encryptedData = await this.encryptBookmark(bookmark, password, category.salt);
      bookmark = {
        id: bookmark.id,
        categoryId: bookmark.categoryId,
        domain: bookmark.domain,
        createdAt: bookmark.createdAt,
        encrypted: true,
        encryptedData: encryptedData
      };
    }

    bookmarks.push(bookmark);
    await chrome.storage.local.set({ bookmarks });

    this.showSuccess('Bookmarked!');
    this.loadBookmarks(); // Refresh the bookmarks list
  }

  async getOrCreateCategory(domain) {
    const data = await chrome.storage.local.get(['categories', 'domainCategoryMap', 'settings']);
    const categories = data.categories || [];
    const domainCategoryMap = data.domainCategoryMap || {};
    const settings = data.settings || { autoCreateCategories: true };

    // Check if domain already has a category mapped (even if renamed)
    if (domainCategoryMap[domain]) {
      return domainCategoryMap[domain];
    }

    // Create new category if auto-create is enabled
    if (settings.autoCreateCategories) {
      const categoryName = this.formatCategoryName(domain);
      const categoryId = this.generateId();
      
      const category = {
        id: categoryId,
        name: categoryName,
        originalDomain: domain, // Store original domain
        createdAt: Date.now(),
        password: null
      };

      categories.push(category);
      domainCategoryMap[domain] = categoryId;

      await chrome.storage.local.set({ 
        categories, 
        domainCategoryMap 
      });

      return categoryId;
    } else {
      // Use default category
      let defaultCategory = categories.find(c => c.name === settings.defaultCategoryName);
      
      if (!defaultCategory) {
        const categoryId = this.generateId();
        defaultCategory = {
          id: categoryId,
          name: settings.defaultCategoryName,
          createdAt: Date.now(),
          password: null
        };
        categories.push(defaultCategory);
        await chrome.storage.local.set({ categories });
      }

      return defaultCategory.id;
    }
  }

  formatCategoryName(domain) {
    // Remove www. and common TLDs for cleaner names
    return domain
      .replace(/^www\./, '')
      .split('.')[0]
      .charAt(0).toUpperCase() + domain.replace(/^www\./, '').split('.')[0].slice(1);
  }

  async loadBookmarks() {
    const data = await chrome.storage.local.get(['bookmarks', 'categories']);
    const bookmarks = data.bookmarks || [];
    const categories = data.categories || [];

    const container = document.getElementById('categoriesList');
    container.innerHTML = '';

    if (categories.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📚</div>
          <p>No bookmarks yet!</p>
        </div>
      `;
      return;
    }

    // Group bookmarks by category
    const bookmarksByCategory = {};
    categories.forEach(cat => {
      bookmarksByCategory[cat.id] = [];
    });

    bookmarks.forEach(bookmark => {
      if (bookmarksByCategory[bookmark.categoryId]) {
        bookmarksByCategory[bookmark.categoryId].push(bookmark);
      }
    });

    // Render categories
    categories.forEach(category => {
      const categoryBookmarks = bookmarksByCategory[category.id] || [];
      const categoryEl = this.createCategoryElement(category, categoryBookmarks);
      container.appendChild(categoryEl);
    });
  }

  createCategoryElement(category, bookmarks) {
    const div = document.createElement('div');
    div.className = 'category-item';
    div.dataset.categoryId = category.id;

    const isExpanded = this.expandedCategories.has(category.id);
    const isLocked = category.password !== null;

    // Use decrypted bookmarks if available in cache
    let displayBookmarks = bookmarks;
    if (isLocked && isExpanded && this.decryptedCache.has(category.id)) {
      displayBookmarks = this.decryptedCache.get(category.id);
    }

    div.innerHTML = `
      <div class="category-header ${isLocked ? 'locked' : ''}" data-category-id="${category.id}">
        <div class="category-title">
          <span class="category-toggle">${isExpanded ? '▼' : '▶'}</span>
          <span class="category-name" data-category-id="${category.id}">${category.name}</span>
          <span class="category-count">${bookmarks.length}</span>
          ${isLocked ? '<span>🔒</span>' : ''}
        </div>
        <div class="category-actions">
          <button class="category-btn" data-action="rename" data-category-id="${category.id}" title="Rename">✏️</button>
          <button class="category-btn" data-action="password" data-category-id="${category.id}" title="${isLocked ? 'Change/Remove Password' : 'Set Password'}">🔐</button>
          <button class="category-btn" data-action="delete" data-category-id="${category.id}" title="Delete Category">🗑️</button>
        </div>
      </div>
      <div class="bookmarks-container ${isExpanded ? 'expanded' : ''}">
        ${isLocked && !isExpanded ? '<div class="locked-message">🔒 This category is password protected. Click to unlock.</div>' : displayBookmarks.map(b => this.createBookmarkHTML(b)).join('')}
      </div>
    `;

    // Event listeners
    const header = div.querySelector('.category-header');
    header.addEventListener('click', async (e) => {
      if (!e.target.closest('.category-actions') && !e.target.closest('.category-name')) {
        await this.toggleCategory(category.id);
      }
    });

    // Category action buttons
    div.querySelectorAll('.category-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const categoryId = btn.dataset.categoryId;

        if (action === 'rename') {
          this.renameCategory(categoryId);
        } else if (action === 'password') {
          this.manageCategoryPassword(categoryId);
        } else if (action === 'delete') {
          this.deleteCategory(categoryId);
        }
      });
    });

    // Bookmark checkboxes and actions
    div.querySelectorAll('.bookmark-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          this.selectedBookmarks.add(e.target.dataset.bookmarkId);
        } else {
          this.selectedBookmarks.delete(e.target.dataset.bookmarkId);
        }
        this.updateDeleteButton();
      });
    });

    div.querySelectorAll('.bookmark-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        const bookmarkId = btn.dataset.bookmarkId;

        if (action === 'open') {
          this.openBookmark(bookmarkId);
        } else if (action === 'delete') {
          this.deleteSingleBookmark(bookmarkId);
        }
      });
    });

    return div;
  }

  createBookmarkHTML(bookmark) {
    return `
      <div class="bookmark-item">
        <input type="checkbox" class="bookmark-checkbox" data-bookmark-id="${bookmark.id}">
        <div class="bookmark-info">
          <div class="bookmark-title">${bookmark.title}</div>
          <div class="bookmark-url">${bookmark.url}</div>
        </div>
        <div class="bookmark-actions">
          <button class="bookmark-btn" data-action="open" data-bookmark-id="${bookmark.id}" title="Open">🔗</button>
          <button class="bookmark-btn" data-action="delete" data-bookmark-id="${bookmark.id}" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }

  async toggleCategory(categoryId) {
    // If category is being expanded and is password protected, verify password first
    if (!this.expandedCategories.has(categoryId)) {
      const data = await chrome.storage.local.get(['categories', 'bookmarks']);
      const category = data.categories.find(c => c.id === categoryId);
      
      if (category && category.password) {
        const inputPassword = prompt('Enter password to view this category:');
        if (!inputPassword) return;

        const hashedInput = await this.hashPassword(inputPassword);
        if (hashedInput !== category.password) {
          alert('Incorrect password!');
          return;
        }

        // Decrypt bookmarks for this category
        const categoryBookmarks = data.bookmarks.filter(b => b.categoryId === categoryId && b.encrypted);
        const decryptedBookmarks = [];

        for (const bookmark of categoryBookmarks) {
          try {
            const decrypted = await this.decryptBookmark(bookmark, inputPassword, category.salt);
            decryptedBookmarks.push({ id: bookmark.id, ...decrypted });
          } catch (e) {
            console.error('Failed to decrypt bookmark:', e);
            alert('Failed to decrypt bookmarks. Password may have been corrupted.');
            return;
          }
        }

        // Cache decrypted bookmarks
        this.decryptedCache.set(categoryId, decryptedBookmarks);
      }
      
      this.expandedCategories.add(categoryId);
    } else {
      this.expandedCategories.delete(categoryId);
      // Clear decrypted cache when collapsing
      this.decryptedCache.delete(categoryId);
    }
    
    this.loadBookmarks();
  }

  async renameCategory(categoryId) {
    const data = await chrome.storage.local.get(['categories']);
    const categories = data.categories || [];
    const category = categories.find(c => c.id === categoryId);

    if (!category) return;

    const newName = prompt('Enter new category name:', category.name);
    if (newName && newName.trim() !== '') {
      category.name = newName.trim();
      await chrome.storage.local.set({ categories });
      this.loadBookmarks();
    }
  }

  async manageCategoryPassword(categoryId) {
    const data = await chrome.storage.local.get(['categories', 'bookmarks']);
    const categories = data.categories || [];
    const bookmarks = data.bookmarks || [];
    const category = categories.find(c => c.id === categoryId);

    if (!category) return;

    if (category.password) {
      // Category has password - verify before allowing changes
      const inputPassword = prompt('Enter current password to manage:');
      if (!inputPassword) return;

      const hashedInput = await this.hashPassword(inputPassword);
      if (hashedInput !== category.password) {
        alert('Incorrect password!');
        return;
      }

      // Ask if they want to change or remove
      const action = confirm('OK = Change password, Cancel = Remove password');
      if (action) {
        // Change password - need to re-encrypt all bookmarks
        const newPassword = prompt('Enter new password:');
        if (newPassword && newPassword.trim() !== '') {
          // Decrypt bookmarks with old password
          const categoryBookmarks = bookmarks.filter(b => b.categoryId === categoryId && b.encrypted);
          const decryptedBookmarks = [];
          
          for (const bookmark of categoryBookmarks) {
            try {
              const decrypted = await this.decryptBookmark(bookmark, inputPassword, category.salt);
              decryptedBookmarks.push({ id: bookmark.id, data: decrypted });
            } catch (e) {
              console.error('Failed to decrypt bookmark:', e);
            }
          }

          // Generate new salt and encrypt with new password
          const newSalt = this.generateSalt();
          category.password = await this.hashPassword(newPassword);
          category.salt = newSalt;

          // Re-encrypt bookmarks
          for (const { id, data } of decryptedBookmarks) {
            const bookmarkIndex = bookmarks.findIndex(b => b.id === id);
            if (bookmarkIndex !== -1) {
              const encryptedData = await this.encryptBookmark(data, newPassword, newSalt);
              bookmarks[bookmarkIndex].encryptedData = encryptedData;
            }
          }

          await chrome.storage.local.set({ categories, bookmarks });
          this.derivedKeys.delete(categoryId); // Clear cached key
          this.decryptedCache.delete(categoryId); // Clear decrypted cache
          this.showSuccess('Password changed and bookmarks re-encrypted!');
          this.loadBookmarks();
        }
      } else {
        // Remove password - decrypt all bookmarks
        const categoryBookmarks = bookmarks.filter(b => b.categoryId === categoryId && b.encrypted);
        
        for (const bookmark of categoryBookmarks) {
          try {
            const decrypted = await this.decryptBookmark(bookmark, inputPassword, category.salt);
            const bookmarkIndex = bookmarks.findIndex(b => b.id === bookmark.id);
            if (bookmarkIndex !== -1) {
              bookmarks[bookmarkIndex] = {
                id: bookmark.id,
                categoryId: bookmark.categoryId,
                domain: bookmark.domain,
                createdAt: bookmark.createdAt,
                url: decrypted.url,
                title: decrypted.title,
                encrypted: false
              };
              delete bookmarks[bookmarkIndex].encryptedData;
            }
          } catch (e) {
            console.error('Failed to decrypt bookmark:', e);
          }
        }

        category.password = null;
        category.salt = null;
        await chrome.storage.local.set({ categories, bookmarks });
        this.derivedKeys.delete(categoryId);
        this.decryptedCache.delete(categoryId);
        this.showSuccess('Password removed and bookmarks decrypted!');
        this.loadBookmarks();
      }
    } else {
      // No password set - create one and encrypt existing bookmarks
      const password = prompt('Enter password for this category (12+ characters recommended):');
      if (password && password.trim() !== '') {
        const salt = this.generateSalt();
        category.password = await this.hashPassword(password);
        category.salt = salt;

        // Encrypt all existing bookmarks in this category
        const categoryBookmarks = bookmarks.filter(b => b.categoryId === categoryId && !b.encrypted);
        
        for (const bookmark of categoryBookmarks) {
          const bookmarkIndex = bookmarks.findIndex(b => b.id === bookmark.id);
          if (bookmarkIndex !== -1) {
            const encryptedData = await this.encryptBookmark(bookmark, password, salt);
            bookmarks[bookmarkIndex] = {
              id: bookmark.id,
              categoryId: bookmark.categoryId,
              domain: bookmark.domain,
              createdAt: bookmark.createdAt,
              encrypted: true,
              encryptedData: encryptedData
            };
          }
        }

        await chrome.storage.local.set({ categories, bookmarks });
        this.showSuccess('Password set and existing bookmarks encrypted!');
        this.loadBookmarks();
      }
    }
  }

  async deleteCategory(categoryId) {
    const data = await chrome.storage.local.get(['categories', 'bookmarks']);
    const categories = data.categories || [];
    const bookmarks = data.bookmarks || [];
    const category = categories.find(c => c.id === categoryId);

    if (!category) return;

    // Check password if protected
    if (category.password) {
      const inputPassword = prompt('Enter password to delete this category:');
      if (!inputPassword) return;

      const hashedInput = await this.hashPassword(inputPassword);
      if (hashedInput !== category.password) {
        alert('Incorrect password!');
        return;
      }
    }

    const categoryBookmarks = bookmarks.filter(b => b.categoryId === categoryId);
    const confirmMsg = `Delete "${category.name}" and its ${categoryBookmarks.length} bookmark(s)?`;
    
    if (!confirm(confirmMsg)) return;

    // Remove category and its bookmarks
    const updatedCategories = categories.filter(c => c.id !== categoryId);
    const updatedBookmarks = bookmarks.filter(b => b.categoryId !== categoryId);

    // Update domain map
    const domainCategoryMap = (await chrome.storage.local.get(['domainCategoryMap'])).domainCategoryMap || {};
    const domainsToRemove = Object.keys(domainCategoryMap).filter(domain => domainCategoryMap[domain] === categoryId);
    domainsToRemove.forEach(domain => delete domainCategoryMap[domain]);

    await chrome.storage.local.set({ 
      categories: updatedCategories, 
      bookmarks: updatedBookmarks,
      domainCategoryMap 
    });

    this.showSuccess('Category deleted!');
    this.loadBookmarks();
  }

  async openBookmark(bookmarkId) {
    const data = await chrome.storage.local.get(['bookmarks', 'categories']);
    const bookmark = data.bookmarks.find(b => b.id === bookmarkId);
    
    if (bookmark) {
      let url = bookmark.url;
      
      // If bookmark is encrypted, get URL from decrypted cache
      if (bookmark.encrypted) {
        const decryptedBookmarks = this.decryptedCache.get(bookmark.categoryId);
        if (decryptedBookmarks) {
          const decrypted = decryptedBookmarks.find(b => b.id === bookmarkId);
          if (decrypted) {
            url = decrypted.url;
          }
        }
      }
      
      if (url) {
        chrome.tabs.create({ url: url });
      }
    }
  }

  async deleteSingleBookmark(bookmarkId) {
    if (!confirm('Delete this bookmark?')) return;

    const data = await chrome.storage.local.get(['bookmarks']);
    const bookmarks = data.bookmarks || [];
    const updatedBookmarks = bookmarks.filter(b => b.id !== bookmarkId);

    await chrome.storage.local.set({ bookmarks: updatedBookmarks });
    this.selectedBookmarks.delete(bookmarkId);
    this.loadBookmarks();
    this.updateDeleteButton();
  }

  selectAll() {
    const checkboxes = document.querySelectorAll('.bookmark-checkbox');
    const allSelected = this.selectedBookmarks.size === checkboxes.length;

    if (allSelected) {
      this.selectedBookmarks.clear();
      checkboxes.forEach(cb => cb.checked = false);
    } else {
      checkboxes.forEach(cb => {
        cb.checked = true;
        this.selectedBookmarks.add(cb.dataset.bookmarkId);
      });
    }

    this.updateDeleteButton();
  }

  async deleteSelected() {
    if (this.selectedBookmarks.size === 0) return;

    if (!confirm(`Delete ${this.selectedBookmarks.size} selected bookmark(s)?`)) return;

    const data = await chrome.storage.local.get(['bookmarks']);
    const bookmarks = data.bookmarks || [];
    const updatedBookmarks = bookmarks.filter(b => !this.selectedBookmarks.has(b.id));

    await chrome.storage.local.set({ bookmarks: updatedBookmarks });
    this.selectedBookmarks.clear();
    this.loadBookmarks();
    this.updateDeleteButton();
    this.showSuccess('Bookmarks deleted!');
  }

  updateDeleteButton() {
    const btn = document.getElementById('deleteSelectedBtn');
    btn.disabled = this.selectedBookmarks.size === 0;
    btn.textContent = this.selectedBookmarks.size > 0 
      ? `Delete Selected (${this.selectedBookmarks.size})` 
      : 'Delete Selected';
  }

  searchBookmarks(query) {
    const normalizedQuery = query.toLowerCase().trim();
    
    if (!normalizedQuery) {
      // Show all bookmarks
      document.querySelectorAll('.bookmark-item').forEach(item => {
        item.style.display = 'flex';
      });
      document.querySelectorAll('.category-item').forEach(item => {
        item.style.display = 'block';
      });
      return;
    }

    // Filter bookmarks
    document.querySelectorAll('.bookmark-item').forEach(item => {
      const title = item.querySelector('.bookmark-title').textContent.toLowerCase();
      const url = item.querySelector('.bookmark-url').textContent.toLowerCase();
      
      if (title.includes(normalizedQuery) || url.includes(normalizedQuery)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });

    // Hide empty categories
    document.querySelectorAll('.category-item').forEach(categoryItem => {
      const visibleBookmarks = categoryItem.querySelectorAll('.bookmark-item[style="display: flex;"]');
      if (visibleBookmarks.length === 0) {
        categoryItem.style.display = 'none';
      } else {
        categoryItem.style.display = 'block';
        // Auto-expand categories with results
        const container = categoryItem.querySelector('.bookmarks-container');
        container.classList.add('expanded');
      }
    });
  }

  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    const saltBytes = new Uint8Array(salt.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encryptBookmark(bookmark, password, salt) {
    const key = await this.deriveKey(password, salt);
    
    // Data to encrypt
    const data = JSON.stringify({
      url: bookmark.url,
      title: bookmark.title
    });

    // Generate IV (initialization vector)
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encoder = new TextEncoder();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encoder.encode(data)
    );

    // Return encrypted data and IV as hex strings
    return {
      ciphertext: Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, '0')).join(''),
      iv: Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
    };
  }

  async decryptBookmark(bookmark, password, salt) {
    const key = await this.deriveKey(password, salt);
    
    // Convert hex strings back to Uint8Arrays
    const ciphertext = new Uint8Array(
      bookmark.encryptedData.ciphertext.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
    );
    const iv = new Uint8Array(
      bookmark.encryptedData.iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decrypted));
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  showSuccess(message) {
    const existingMsg = document.querySelector('.success-message');
    if (existingMsg) existingMsg.remove();

    const msg = document.createElement('div');
    msg.className = 'success-message';
    msg.textContent = message;
    document.querySelector('.container').insertBefore(msg, document.querySelector('.container').firstChild.nextSibling);

    setTimeout(() => msg.remove(), 2000);
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new BookmarkManager();
});
