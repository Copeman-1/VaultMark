// Background service worker for Privacy Bookmarks

chrome.runtime.onInstalled.addListener(async () => {
  // Initialize storage structure if not exists
  const data = await chrome.storage.local.get(['bookmarks', 'categories', 'settings', 'domainCategoryMap']);
  
  if (!data.bookmarks) {
    await chrome.storage.local.set({ bookmarks: [] });
  }
  
  if (!data.categories) {
    await chrome.storage.local.set({ categories: [] });
  }
  
  if (!data.settings) {
    await chrome.storage.local.set({ 
      settings: {
        autoCreateCategories: true,
        defaultCategoryName: 'Uncategorized'
      }
    });
  }
  
  if (!data.domainCategoryMap) {
    await chrome.storage.local.set({ domainCategoryMap: {} });
  }
  
  console.log('Privacy Bookmarks Extension Initialized');
});
