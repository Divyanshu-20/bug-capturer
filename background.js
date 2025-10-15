/**
 * Bug Capturer Background Service Worker
 * SECURITY: Local storage only, no external network calls
 */

console.log('Background script loaded and running');

// Storage key for master steps array
const STORAGE_KEY = 'bc_steps_master';
const MAX_STORAGE_SIZE = 50 * 1024 * 1024; // 50MB limit
const MAX_STEPS = 1000; // Maximum number of steps to prevent memory issues

/**
 * Get stored steps from chrome.storage.local with size validation
 */
async function getStoredSteps() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEY]);
    const steps = result[STORAGE_KEY] || [];
    
    // Check if we have too many steps and clean up if needed
    if (steps.length > MAX_STEPS) {
      console.warn(`Too many steps (${steps.length}), keeping only latest ${MAX_STEPS}`);
      const trimmedSteps = steps.slice(-MAX_STEPS);
      await storeSteps(trimmedSteps);
      return trimmedSteps;
    }
    
    return steps;
  } catch (error) {
    console.error('Failed to get stored steps:', error);
    return [];
  }
}

/**
 * Store steps array to chrome.storage.local with size limits
 */
async function storeSteps(steps) {
  try {
    // Estimate storage size
    const dataSize = JSON.stringify(steps).length;
    
    if (dataSize > MAX_STORAGE_SIZE) {
      console.warn(`Data too large (${dataSize} bytes), compressing...`);
      // Remove oldest steps to stay under limit
      let trimmedSteps = steps;
      while (JSON.stringify(trimmedSteps).length > MAX_STORAGE_SIZE && trimmedSteps.length > 10) {
        trimmedSteps = trimmedSteps.slice(Math.floor(trimmedSteps.length * 0.1)); // Remove 10% from start
      }
      steps = trimmedSteps;
    }
    
    await chrome.storage.local.set({ [STORAGE_KEY]: steps });
    console.log(`Stored ${steps.length} steps (${JSON.stringify(steps).length} bytes)`);
    return { ok: true };
  } catch (error) {
    console.error('Failed to store steps:', error);
    // If storage fails, try to clear some space
    if (error.message && error.message.includes('QUOTA_EXCEEDED')) {
      console.warn('Storage quota exceeded, clearing old data...');
      await clearSteps();
    }
    return { ok: false, error: error.message };
  }
}

/**
 * Compress screenshot data URL to reduce storage size
 */
async function compressScreenshot(dataURL, quality = 0.7) {
  try {
    // Check memory before starting compression
    if (performance.memory && performance.memory.usedJSHeapSize > 200 * 1024 * 1024) {
      console.warn('High memory usage, skipping compression');
      return dataURL;
    }
    
    // Estimate data size and skip if too large
    const estimatedSize = dataURL.length * 0.75; // Rough estimate of decoded size
    if (estimatedSize > 50 * 1024 * 1024) { // 50MB limit
      console.warn('Image too large for compression, using original');
      return dataURL;
    }
    
    // Convert data URL to blob
    const response = await fetch(dataURL);
    const blob = await response.blob();
    
    // Create image bitmap
    const imageBitmap = await createImageBitmap(blob);
    
    // Calculate new dimensions with more aggressive limits
    const maxWidth = 1000; // Reduced from 1920
    const maxHeight = 800; // Reduced from 1080
    const maxPixels = 800000; // ~800k pixels max
    let { width, height } = imageBitmap;
    
    // Check total pixel count first
    if (width * height > maxPixels) {
      const ratio = Math.sqrt(maxPixels / (width * height));
      width = Math.floor(width * ratio);
      height = Math.floor(height * ratio);
    }
    
    // Also check individual dimensions
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.floor(width * ratio);
      height = Math.floor(height * ratio);
    }
    
    // Create OffscreenCanvas for compression
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get 2D context for compression');
    }
    
    // Draw resized image
    ctx.drawImage(imageBitmap, 0, 0, width, height);
    
    // Convert to compressed blob with adjusted quality for large images
    const adjustedQuality = width * height > 500000 ? Math.min(quality, 0.5) : quality;
    const compressedBlob = await canvas.convertToBlob({ 
      type: 'image/jpeg', 
      quality: adjustedQuality 
    });
    
    // Convert back to data URL
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Calculate compression ratio
        const originalSize = dataURL.length;
        const compressedSize = reader.result.length;
        const compressionRatio = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
        
        console.log(`Screenshot compressed: ${originalSize} -> ${compressedSize} bytes (${compressionRatio}% reduction)`);
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('Failed to convert compressed image to data URL'));
      reader.readAsDataURL(compressedBlob);
    });
  } catch (error) {
    console.error('Screenshot compression failed:', error);
    // Return original data URL if compression fails
    return dataURL;
  }
}

/**
 * Add a new step with improved deduplication and memory management
 * STORAGE BEHAVIOR: More accurate deduplication to prevent false positives
 */
async function addStep(newStep) {
  const steps = await getStoredSteps();
  
  // Check memory limits before adding
  if (steps.length >= MAX_STEPS) {
    console.warn('Maximum steps reached, removing oldest step');
    steps.shift(); // Remove oldest step
  }
  
  // Compress screenshot if present
  if (newStep.dataURL) {
    try {
      newStep.dataURL = await compressScreenshot(newStep.dataURL);
    } catch (compressionError) {
      console.warn('Screenshot compression failed, removing image:', compressionError);
      delete newStep.dataURL; // Remove problematic image
    }
  }
  
  // Improved deduplication: only filter truly identical rapid-fire duplicates
  const now = newStep.time;
  const isDuplicate = steps.some(step => {
    const timeDiff = Math.abs(step.time - now);
    
    // Only filter exact duplicates within 100ms (reduced from 200ms)
    if (timeDiff <= 100 && 
        step.selector === newStep.selector && 
        step.text === newStep.text &&
        step.meta?.action === newStep.meta?.action &&
        step.meta?.value === newStep.meta?.value) {
      return true;
    }
    
    // Only filter rapid identical clicks within 25ms (reduced from 50ms)
    if (timeDiff <= 25 && 
        step.selector === newStep.selector && 
        step.meta?.action === newStep.meta?.action &&
        step.meta?.action === 'click') {
      return true;
    }
    
    // Don't filter form submissions unless they're truly identical
    if (step.meta?.action === 'submit' && newStep.meta?.action === 'submit') {
      return false; // Allow multiple form submissions
    }
    
    // Don't filter screenshots unless they're truly identical
    if (step.type === 'screenshot' && newStep.type === 'screenshot') {
      return false; // Allow multiple screenshots
    }
    
    return false;
  });
  
  if (!isDuplicate) {
    steps.push(newStep);
    console.log(`Step ${steps.length} added:`, newStep.meta?.action, newStep.selector);
    
    // Keep only last 1000 steps to prevent storage bloat
    if (steps.length > 1000) {
      steps.splice(0, steps.length - 1000);
    }
  } else {
    console.log('Duplicate step filtered:', newStep.meta?.action, newStep.selector);
  }
  
  return await storeSteps(steps);
}

/**
 * Clear all stored steps
 */
async function clearSteps() {
  try {
    await chrome.storage.local.remove([STORAGE_KEY]);
    return { ok: true };
  } catch (error) {
    console.error('Failed to clear steps:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Crop screenshot to selected area using OffscreenCanvas (Service Worker compatible)
 */
async function cropScreenshotToArea(dataURL, area) {
  try {
    console.log('Starting crop operation with area:', area);
    
    // Validate input parameters
    if (!dataURL || typeof dataURL !== 'string') {
      throw new Error('Invalid dataURL provided for cropping');
    }
    
    if (!area || typeof area !== 'object' || !area.x || !area.y || !area.width || !area.height) {
      throw new Error('Invalid area coordinates provided for cropping');
    }
    
    // Convert data URL to blob
    const response = await fetch(dataURL);
    if (!response.ok) {
      throw new Error(`Failed to fetch dataURL: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    
    // Create image bitmap from blob
    const imageBitmap = await createImageBitmap(blob);
    console.log('Image bitmap created, dimensions:', imageBitmap.width, 'x', imageBitmap.height);
    
    // Validate and clamp area coordinates with better bounds checking
    let clampedArea = {
      x: Math.max(0, Math.min(area.x, imageBitmap.width - 1)),
      y: Math.max(0, Math.min(area.y, imageBitmap.height - 1)),
      width: Math.max(1, Math.min(area.width, imageBitmap.width - Math.max(0, area.x))),
      height: Math.max(1, Math.min(area.height, imageBitmap.height - Math.max(0, area.y)))
    };
    
    // Ensure the area doesn't exceed image bounds
    if (clampedArea.x + clampedArea.width > imageBitmap.width) {
      clampedArea.width = imageBitmap.width - clampedArea.x;
    }
    if (clampedArea.y + clampedArea.height > imageBitmap.height) {
      clampedArea.height = imageBitmap.height - clampedArea.y;
    }
    
    // Ensure minimum dimensions
    clampedArea.width = Math.max(1, clampedArea.width);
    clampedArea.height = Math.max(1, clampedArea.height);
    
    if (JSON.stringify(area) !== JSON.stringify(clampedArea)) {
      console.warn('Area coordinates clamped:', {
        original: area,
        clamped: clampedArea,
        imageWidth: imageBitmap.width,
        imageHeight: imageBitmap.height
      });
    }
    
    area = clampedArea;
    
    // Final validation before creating OffscreenCanvas
    if (area.width <= 0 || area.height <= 0 || area.width > 10000 || area.height > 10000) {
      throw new Error(`Invalid canvas dimensions: ${area.width}x${area.height}. Area: ${JSON.stringify(area)}`);
    }
    
    console.log('Creating OffscreenCanvas with dimensions:', area.width, 'x', area.height);
    
    // Create OffscreenCanvas for cropping
    const canvas = new OffscreenCanvas(area.width, area.height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }
    
    console.log('Drawing cropped portion:', {
      sourceX: area.x,
      sourceY: area.y,
      sourceWidth: area.width,
      sourceHeight: area.height,
      destX: 0,
      destY: 0,
      destWidth: area.width,
      destHeight: area.height
    });
    
    // Draw the cropped portion of the image
    ctx.drawImage(
      imageBitmap,
      area.x, area.y, area.width, area.height,  // Source rectangle
      0, 0, area.width, area.height              // Destination rectangle
    );
    
    // Convert canvas to blob with error handling
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png', quality: 0.8 });
    console.log('Cropped blob created, size:', croppedBlob.size, 'bytes');
    
    if (croppedBlob.size === 0) {
      throw new Error('Cropped image is empty - check area coordinates');
    }
    
    // Convert blob back to data URL
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        console.log('Cropped image converted to data URL, length:', reader.result.length);
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('Failed to convert cropped image to data URL'));
      reader.readAsDataURL(croppedBlob);
    });
  } catch (error) {
    console.error('Screenshot cropping error:', error);
    throw error;
  }
}

/**
 * Handle messages from content scripts and popup
 */
// Track active message handlers to prevent memory leaks
const activeHandlers = new Set();

// Cleanup function for removing stale handlers
function cleanupHandlers() {
  if (activeHandlers.size > 100) {
    console.warn('Too many active handlers, clearing some...');
    activeHandlers.clear();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlerId = Date.now() + Math.random();
  activeHandlers.add(handlerId);
  
  console.log('Background script received message:', message.cmd, 'from sender:', sender);
  console.log('Full message object:', JSON.stringify(message, null, 2));
  
  // Handle async operations properly
  (async () => {
    try {
      console.log('Processing message with cmd:', message.cmd);
      switch (message.cmd) {
        case 'store-step':
        case 'add-step':
          if (message.step) {
            const result = await addStep(message.step);
            sendResponse(result);
          } else {
            sendResponse({ ok: false, error: 'No step provided' });
          }
          break;
          
        case 'get-steps':
          const steps = await getStoredSteps();
          sendResponse({ ok: true, steps });
          break;
          
        case 'clear-steps':
        case 'clear-all':
          const clearResult = await clearSteps();
          
          // Enhanced cleanup: also clear temporary data and cached URLs
          try {
            await chrome.storage.local.remove([
              'bc_current_url',
              'lastReport',
              'reportGeneratedAt',
              'bc_session_screenshots',
              'bc_temp_data',
              'bc_last_tab_id',
              'screenshots'
            ]);
            console.log('Comprehensive cleanup completed in background script');
          } catch (cleanupError) {
            console.warn('Some cleanup operations failed:', cleanupError);
          }
          
          sendResponse(clearResult);
          break;
          
        case 'get-current-tab-url':
          try {
            // First try to get the stored/tracked URL
            let currentUrl = null;
            
            // Check if we have a stored URL from our tracking
            const storedData = await chrome.storage.local.get(['bc_current_url', 'bc_last_tab_id']);
            if (storedData.bc_current_url) {
              currentUrl = storedData.bc_current_url;
              console.log('Using tracked URL:', currentUrl);
            }
            
            // Fallback to querying active tab if no stored URL
            if (!currentUrl) {
              const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (activeTab && activeTab.url) {
                currentUrl = activeTab.url;
                console.log('Using active tab URL:', currentUrl);
              }
            }
            
            if (currentUrl) {
              sendResponse({ url: currentUrl });
            } else {
              sendResponse({ url: null, error: 'No URL available' });
            }
          } catch (error) {
            console.error('Error getting current tab URL:', error);
            sendResponse({ url: null, error: error.message });
          }
          break;
          
        case 'update-current-url':
          try {
            // Store the updated URL for the current session
            if (message.url && sender.tab) {
              console.log('Updating current URL to:', message.url, 'for tab:', sender.tab.id);
              
              // Update persistent state with latest URL
              persistentState.currentUrl = message.url;
              persistentState.lastUpdatedTabId = sender.tab.id;
              
              // Store in chrome storage for persistence
              await chrome.storage.local.set({
                'bc_current_url': message.url,
                'bc_last_tab_id': sender.tab.id,
                'bc_url_updated_at': Date.now()
              });
              
              sendResponse({ ok: true, url: message.url });
            } else {
              sendResponse({ ok: false, error: 'Invalid URL or sender tab' });
            }
          } catch (error) {
             console.error('Error updating current URL:', error);
             sendResponse({ ok: false, error: error.message });
           }
           break;
           
        case 'export-steps':
          const exportSteps = await getStoredSteps();
          if (exportSteps.length === 0) {
            sendResponse({success: false, message: 'No steps to export'});
            return;
          }
          
          const exportRTFReport = generateRTFReport(exportSteps);
          downloadRTFDocument(exportRTFReport);
          sendResponse({success: true, message: 'Word document export completed'});
          break;
          
        case 'export-steps-with-assets':
          const exportStepsWithAssets = await getStoredSteps();
          if (exportStepsWithAssets.length === 0) {
            sendResponse({success: false, message: 'No steps to export'});
            return;
          }
          
          const rtfReportWithAssets = generateRTFReport(exportStepsWithAssets);
          downloadRTFDocument(rtfReportWithAssets);
          sendResponse({success: true, message: 'Word document export with embedded images completed'});
          break;
          
        case 'download-report-with-images':
          const downloadSteps = await getStoredSteps();
          if (downloadSteps.length === 0) {
            sendResponse({success: false, message: 'No steps to export'});
            return;
          }
          
          // Generate Word document with embedded images
          const rtfReport = await generateRTFReport(downloadSteps);
          
          // Download the Word document (images are already embedded)
          downloadRTFDocument(rtfReport);
          sendResponse({success: true, message: 'Word document with embedded images downloaded'});
          break;
          
        case 'save-report':
          // Save generated report
          persistentState.lastReport = message.report;
          await chrome.storage.local.set({ 
            lastReport: message.report,
            reportGeneratedAt: Date.now()
          });
          
          // If this is a pause report, just save it (no auto-download)
          if (message.isPause) {
            console.log('Pause report saved to storage (preview mode)');
          }
          
          console.log('Report saved to storage');
          sendResponse({ ok: true });
          break;
          
        case 'get-persistent-state':
          // Get from chrome.storage for most up-to-date state
          const storageResult = await chrome.storage.local.get(['isRecording', 'sessionId', 'startTime']);
          const state = {
            isRecording: storageResult.isRecording === true, // Ensure boolean
            sessionId: storageResult.sessionId || null,
            startTime: storageResult.startTime || null,
            lastReport: persistentState.lastReport
          };
          // Update in-memory state
          persistentState = { ...persistentState, ...state };
          console.log('Returning persistent state:', state);
          sendResponse({ ok: true, state });
          break;
          
        case 'test-message':
          console.log('Test message received successfully');
          sendResponse({ success: true, message: 'Background script is working' });
          break;
          
        case 'capture-screenshot':
        case 'capture-screenshot-pause':
          // Capture screenshot of the current tab with memory management
          try {
            console.log('Screenshot capture request received:', message);
            
            // Check memory before capturing
            if (performance.memory && performance.memory.usedJSHeapSize > 100 * 1024 * 1024) {
              console.warn('High memory usage detected, skipping screenshot');
              sendResponse({ ok: false, error: 'Memory limit reached' });
              break;
            }
            
            // Get the active tab since popup doesn't have sender.tab
            console.log('Querying for active tab...');
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            console.log('Tabs query result:', tabs);
            const [activeTab] = tabs;
            console.log('Active tab found:', activeTab);
            
            if (activeTab && activeTab.id) {
              console.log('Capturing screenshot for tab:', activeTab.id, 'window:', activeTab.windowId);
              
              const screenshot = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
                format: 'png',
                quality: 80
              });
              
              console.log('Screenshot captured, data URL length:', screenshot.length);
              
              // Compress screenshot for storage efficiency
              const compressedScreenshot = await compressScreenshot(screenshot, 0.8);
              console.log('Screenshot compressed, new length:', compressedScreenshot.length);
              
              // Create screenshot step for recording
              const screenshotStep = {
                type: 'screenshot',
                time: message.timestamp || Date.now(),
                description: message.cmd === 'capture-screenshot-pause' ? 'Screenshot captured during pause' : 'Screenshot captured',
                dataURL: compressedScreenshot,
                timestamp: message.timestamp || Date.now(),
                url: activeTab.url,
                viewport: `${activeTab.width || 'unknown'}x${activeTab.height || 'unknown'}`,
                meta: {
                  action: 'screenshot',
                  timestamp: (message.timestamp || Date.now()) - (persistentState.startTime || Date.now())
                }
              };
              
              // Store the screenshot step
              await addStep(screenshotStep);
              console.log('Screenshot step stored successfully');
              
              sendResponse({ success: true, screenshot: screenshotStep });
            } else {
              console.error('No active tab found');
              sendResponse({ success: false, error: 'No active tab found' });
            }
          } catch (error) {
            console.error('Screenshot capture failed:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;
          
        case 'capture-screenshot-custom':
          // Capture custom area screenshot
          try {
            console.log('Custom area screenshot capture request received:', message);
            console.log('Area coordinates received:', message.area);
            
            // Get the active tab
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const [activeTab] = tabs;
            
            if (!activeTab || !activeTab.id) {
              console.error('No active tab found');
              sendResponse({ success: false, error: 'No active tab found' });
              return;
            }
            
            console.log('Active tab dimensions:', { width: activeTab.width, height: activeTab.height });
            
            // Capture full screenshot first
            const fullScreenshot = await chrome.tabs.captureVisibleTab(activeTab.windowId, {
              format: 'png',
              quality: 80
            });
            console.log('Full screenshot captured, data length:', fullScreenshot.length);
            
            // Crop the screenshot to the selected area
            const croppedScreenshot = await cropScreenshotToArea(fullScreenshot, message.area);
            console.log('Screenshot cropped to area:', message.area);
            
            // Compress cropped screenshot for storage efficiency
            const compressedScreenshot = await compressScreenshot(croppedScreenshot, 0.8);
            console.log('Cropped screenshot compressed, new length:', compressedScreenshot.length);
            
            // Create screenshot step for recording
            const screenshotStep = {
              type: 'screenshot',
              time: message.timestamp || Date.now(),
              description: `Custom area screenshot (${message.area.width}x${message.area.height})`,
              dataURL: compressedScreenshot,
              timestamp: message.timestamp || Date.now(),
              url: activeTab.url,
              viewport: `${message.area.width}x${message.area.height}`,
              area: message.area,
              meta: {
                action: 'screenshot-custom',
                timestamp: (message.timestamp || Date.now()) - (persistentState.startTime || Date.now())
              }
            };
            
            // Store the screenshot step
            await addStep(screenshotStep);
            console.log('Custom screenshot step stored successfully');
            
            sendResponse({ success: true, screenshot: screenshotStep });
          } catch (error) {
            console.error('Custom screenshot capture failed:', error);
            sendResponse({ success: false, error: error.message });
          }
          break;
          
        case 'update-recording-state':
          // Update persistent recording state
          persistentState.isRecording = message.isRecording === true;
          persistentState.sessionId = message.sessionId || null;
          persistentState.startTime = message.startTime || null;
          
          await chrome.storage.local.set({ 
            isRecording: persistentState.isRecording,
            sessionId: persistentState.sessionId,
            startTime: persistentState.startTime
          });
          
          console.log('Recording state updated:', persistentState);
          sendResponse({ ok: true });
          break;
          
        case 'custom-screenshot-captured':
          // Store custom screenshot in popup screenshots storage and main steps
          try {
            console.log('Background script received custom screenshot:', message.screenshot);
            
            // Compress screenshot for storage efficiency
            const compressedDataURL = await compressScreenshot(message.screenshot.dataURL, 0.8);
            console.log('Custom screenshot compressed, original length:', message.screenshot.dataURL.length, 'compressed length:', compressedDataURL.length);
            
            // Create compressed screenshot object
            const compressedScreenshot = {
              ...message.screenshot,
              dataURL: compressedDataURL
            };
            
            // Store in screenshots array for popup gallery
            const result = await chrome.storage.local.get(['screenshots']);
            const screenshots = result.screenshots || [];
            console.log('Current screenshots in storage:', screenshots.length);
            
            // Add the new screenshot to the beginning
            screenshots.unshift(compressedScreenshot);
            
            // Limit to 20 screenshots
            if (screenshots.length > 20) {
              screenshots.splice(20);
            }
            
            // Save screenshots array
            await chrome.storage.local.set({ screenshots: screenshots });
            
            // Note: Custom screenshots are only stored in the screenshots array for gallery display
            // They are NOT stored as steps to avoid duplication in report previews
            
            console.log('Custom screenshot stored in screenshots array for gallery. Total screenshots:', screenshots.length);
            sendResponse({ ok: true });
          } catch (error) {
            console.error('Failed to store custom screenshot:', error);
            sendResponse({ ok: false, error: error.message });
          }
          break;
          
        case 'add-screenshot-to-gallery':
          // Add screenshot to popup's screenshots array
          try {
            console.log('Adding screenshot to gallery:', message.screenshot);
            
            // Get current screenshots from storage
            const result = await chrome.storage.local.get(['screenshots']);
            const screenshots = result.screenshots || [];
            
            // Add the new screenshot to the beginning
            screenshots.unshift(message.screenshot);
            
            // Limit to 20 screenshots
            if (screenshots.length > 20) {
              screenshots.splice(20);
            }
            
            // Save screenshots array
            await chrome.storage.local.set({ screenshots: screenshots });
            
            console.log('Screenshot added to gallery. Total screenshots:', screenshots.length);
            sendResponse({ ok: true });
          } catch (error) {
            console.error('Failed to add screenshot to gallery:', error);
            sendResponse({ ok: false, error: error.message });
          }
          break;
          
        default:
          sendResponse({ ok: false, error: 'Unknown command' });
      }
    } catch (error) {
      console.error('Background script error:', error);
      sendResponse({ ok: false, error: error.message });
    } finally {
      // Cleanup handler reference
      activeHandlers.delete(handlerId);
      
      // Periodic cleanup
      if (Math.random() < 0.1) { // 10% chance
        cleanupHandlers();
      }
    }
  })();
  
  // Return true to indicate we'll send response asynchronously
  return true;
});

/**
 * Save screenshot as separate file and return the filename
 */
async function saveScreenshotAsFile(screenshot, index) {
  try {
    // Create filename with simple numbering
    const filename = `screenshot${String(index + 1).padStart(2, '0')}.png`;
    
    // Save as file using chrome.downloads API directly with data URL
    return new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: screenshot.dataURL,
        filename: `bug-report-assets/${filename}`,
        saveAs: false // Don't show save dialog
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('Failed to save screenshot:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
        } else {
          console.log('Screenshot saved:', filename);
          resolve(filename);
        }
      });
    });
  } catch (error) {
    console.error('Error saving screenshot:', error);
    return null;
  }
}

/**
 * Generate markdown report with separate asset files (for stop operations only)
 */
async function generateMarkdownReportWithAssets(steps) {
  // Filter out console and performance events
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && step.type !== 'performance'
  );
  
  if (uiSteps.length === 0) {
    return `# Bug Report\n\n**Generated:** ${new Date().toLocaleString()}\n\n**No UI interaction steps recorded.**\n`;
  }
  
  const startTime = uiSteps[0].time;
  const endTime = uiSteps[uiSteps.length - 1].time;
  const duration = Math.round((endTime - startTime) / 1000);
  
  // Get URL for title generation
  const storedData = await chrome.storage.local.get(['bc_current_url']);
  const url = storedData.bc_current_url || uiSteps[0]?.url || 'Unknown URL';
  
  // Generate title based on URL
  let title = `Issue on ${url}`;
  
  // Find screenshots in steps
  const screenshots = uiSteps.filter(step => step.type === 'screenshot' && step.dataURL);
  
  // Save screenshots as separate files
  const savedScreenshots = [];
  for (let i = 0; i < screenshots.length; i++) {
    const filename = await saveScreenshotAsFile(screenshots[i], i);
    if (filename) {
      savedScreenshots.push({
        ...screenshots[i],
        filename: filename
      });
    }
  }
  
  // Calculate statistics
  const stats = {
    total: uiSteps.length,
    click: uiSteps.filter(s => s.meta?.action === 'click').length,
    form: uiSteps.filter(s => ['input', 'select', 'focus', 'blur', 'submit'].includes(s.meta?.action)).length,
    navigation: uiSteps.filter(s => s.meta?.action === 'navigation').length,
    error: uiSteps.filter(s => s.type === 'error-detected' || s.meta?.level === 'error').length,
    warning: uiSteps.filter(s => s.meta?.level === 'warning').length,
    success: uiSteps.filter(s => s.meta?.level === 'success').length
  };
  
  let markdown = `# ${title}\n\n`;
  
  // Statistics at the top
  markdown += `## 📊 Statistics\n\n`;
  markdown += `- **Total UI Steps:** ${stats.total}\n`;
  markdown += `- **Click Actions:** ${stats.click}\n`;
  markdown += `- **Form Interactions:** ${stats.form}\n`;
  markdown += `- **Navigation Actions:** ${stats.navigation}\n`;
  if (stats.error > 0) markdown += `- **Errors:** ${stats.error}\n`;
  if (stats.warning > 0) markdown += `- **Warnings:** ${stats.warning}\n`;
  if (stats.success > 0) markdown += `- **Success Events:** ${stats.success}\n`;
  markdown += `- **Duration:** ${duration} seconds\n`;
  markdown += `- **Generated:** ${new Date().toLocaleString()}\n\n`;
  
  // Defect Screenshot section with separate files
  if (savedScreenshots.length > 0) {
    markdown += `## 📸 Defect Screenshot\n\n`;
    savedScreenshots.forEach((screenshot, index) => {
      const screenshotDesc = screenshot.description || `Screenshot ${index + 1}`;
      markdown += `![${screenshotDesc}](./bug-report-assets/${screenshot.filename})\n\n`;
    });
  }
  
  // Steps to Reproduce
  markdown += `## 📝 Steps to Reproduce\n\n`;
  
  uiSteps.forEach((step, index) => {
    const action = step.meta?.action || step.type || 'action';
    const target = step.text || step.selector || 'element';
    
    // Generate clean, simple step description
    let stepDescription = '';
    switch (action) {
      case 'click':
        stepDescription = `User clicked on ${target}.`;
        break;
      case 'input':
        stepDescription = `User entered "${step.meta?.value || step.text || ''}" in ${target}.`;
        break;
      case 'select':
        stepDescription = `User selected "${step.meta?.value || step.text || ''}" from ${target}.`;
        break;
      case 'focus':
        stepDescription = `User focused on ${target}.`;
        break;
      case 'blur':
        stepDescription = `User left ${target}.`;
        break;
      case 'submit':
        stepDescription = `User submitted the form.`;
        break;
      case 'navigation':
        stepDescription = `User performed navigation on ${target}.`;
        break;
      case 'keypress':
        stepDescription = `User pressed ${step.text || 'a key'}.`;
        break;
      case 'change':
        stepDescription = `User performed change on ${target}.`;
        break;
      case 'toggle':
        stepDescription = `User toggled ${target}.`;
        break;
      case 'screenshot':
        stepDescription = `Screenshot captured: ${step.description || 'Manual screenshot'}.`;
        break;
      default:
        stepDescription = `User performed ${action} on ${target}.`;
    }
    
    markdown += `${stepDescription}\n`;
  });
  
  markdown += `\n## ✅ Expected Results\n\n`;
  markdown += `*[Please fill in the expected behavior here]*\n\n`;
  
  // Actual Results as summary of steps
  markdown += `## ❌ Actual Results\n\n`;
  markdown += `**URL:** ${url}\n`;
  markdown += `**Steps performed:** ${stats.total} actions recorded\n`;
  markdown += `**Details:** See "Steps to Reproduce" section above for detailed actions\n\n`;
  markdown += `*[Please describe what actually happened and any error messages or unexpected behavior]*\n\n`;
  
  // Environment metadata
  markdown += `## 🖥️ Environment\n\n`;
  markdown += `- **URL:** ${url}\n`;
  // Browser info not available in service worker context
  markdown += `- **Generated:** ${new Date().toLocaleString()}\n`;
  markdown += `- **Report Type:** Bug Context Capturer\n`;
  
  return markdown;
}

/**
 * Generate Word document report from steps with embedded images
 * Only includes UI interactions, excludes console and performance events
 */
async function generateRTFReport(steps) {
  // Filter out console and performance events
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && step.type !== 'performance'
  );
  
  if (uiSteps.length === 0) {
    return `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}
{\\colortbl;\\red0\\green0\\blue0;}
\\f0\\fs24
{\\b Bug Report}\\par
\\par
Generated: ${new Date().toLocaleString()}\\par
\\par
No UI interaction steps recorded.\\par
}`;
  }
  
  const startTime = uiSteps[0].time;
  const endTime = uiSteps[uiSteps.length - 1].time;
  const duration = Math.round((endTime - startTime) / 1000);
  
  // Get URL for title generation
  const storedData = await chrome.storage.local.get(['bc_current_url']);
  const url = storedData.bc_current_url || uiSteps[0]?.url || 'Unknown URL';
  
  // Generate title based on URL
  let title = `Issue on ${url}`;
  
  // Find screenshots in steps
  const screenshots = uiSteps.filter(step => step.type === 'screenshot' && step.dataURL);
  
  // Calculate statistics
  const stats = {
    total: uiSteps.length,
    click: uiSteps.filter(s => s.meta?.action === 'click').length,
    form: uiSteps.filter(s => ['input', 'select', 'focus', 'blur', 'submit'].includes(s.meta?.action)).length,
    navigation: uiSteps.filter(s => s.meta?.action === 'navigation').length,
    error: uiSteps.filter(s => s.type === 'error-detected' || s.meta?.level === 'error').length,
    warning: uiSteps.filter(s => s.meta?.level === 'warning').length,
    success: uiSteps.filter(s => s.meta?.level === 'success').length
  };
  
  // Generate RTF content
  let rtfContent = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}
{\\colortbl;\\red0\\green0\\blue0;}
\\f0\\fs24
{\\b\\fs28 🐛 ${title}}\\par
\\par
{\\b Generated:} ${new Date().toLocaleString()}\\par
{\\b URL:} ${url}\\par
{\\b Duration:} ${duration} seconds\\par
{\\b Total Steps:} ${stats.total}\\par
\\par
{\\b\\fs26 📊 Statistics}\\par
\\par
Total UI Steps: ${stats.total}\\par
Click Actions: ${stats.click}\\par
Form Interactions: ${stats.form}\\par
Navigation Actions: ${stats.navigation}\\par`;
  
  if (stats.error > 0) rtfContent += `\\par
Errors: ${stats.error}\\par`;
  if (stats.warning > 0) rtfContent += `\\par
Warnings: ${stats.warning}\\par`;
  if (stats.success > 0) rtfContent += `\\par
Success Events: ${stats.success}\\par`;
  
  rtfContent += `\\par
\\par`;
  
  // Screenshots section - BEFORE steps to reproduce as requested
  if (screenshots.length > 0) {
    rtfContent += `{\\b\\fs26 📸 Defect Screenshots}\\par
\\par`;
    
    screenshots.forEach((screenshot, index) => {
      const screenshotDesc = screenshot.description || `Screenshot ${index + 1}`;
      rtfContent += `{\\b ${screenshotDesc}}\\par
[Image: ${screenshot.dataURL ? 'Screenshot data available' : 'No screenshot data'}]\\par
\\par`;
    });
  }
  
  // Steps to Reproduce - AFTER screenshots as requested
  rtfContent += `{\\b\\fs26 📝 Steps to Reproduce}\\par
\\par`;
  
  uiSteps.forEach((step, index) => {
    const action = step.meta?.action || step.type || 'action';
    const target = step.text || step.selector || 'element';
    
    // Generate clean, simple step description
    let stepDescription = '';
    switch (action) {
      case 'click':
        stepDescription = `User clicked on ${target}.`;
        break;
      case 'input':
        stepDescription = `User entered "${step.meta?.value || step.text || ''}" in ${target}.`;
        break;
      case 'select':
        stepDescription = `User selected "${step.meta?.value || step.text || ''}" from ${target}.`;
        break;
      case 'focus':
        stepDescription = `User focused on ${target}.`;
        break;
      case 'blur':
        stepDescription = `User left ${target}.`;
        break;
      case 'submit':
        stepDescription = `User submitted the form.`;
        break;
      case 'navigation':
        stepDescription = `User performed navigation on ${target}.`;
        break;
      case 'keypress':
        stepDescription = `User pressed ${step.text || 'a key'}.`;
        break;
      case 'change':
        stepDescription = `User performed change on ${target}.`;
        break;
      case 'toggle':
        stepDescription = `User toggled ${target}.`;
        break;
      case 'screenshot':
        // Skip screenshot steps in the reproduction steps since they're shown above
        return;
      default:
        stepDescription = `User performed ${action} on ${target}.`;
    }
    
    rtfContent += `${index + 1}. ${stepDescription}\\par
\\par`;
  });
  
  rtfContent += `{\\b\\fs26 ✅ Expected Results}\\par
\\par
[Please fill in the expected behavior here]\\par
\\par
{\\b\\fs26 ❌ Actual Results}\\par
\\par
URL: ${url}\\par
Steps performed: ${stats.total} actions recorded\\par
Details: See "Steps to Reproduce" section above for detailed actions\\par
[Please describe what actually happened and any error messages or unexpected behavior]\\par
\\par
{\\b\\fs26 🖥️ Environment}\\par
\\par
URL: ${url}\\par
Generated: ${new Date().toLocaleString()}\\par
Report Type: Bug Context Capturer\\par
}`;
  
  return rtfContent;
}

/**
 * Generate empty Word document report
 */
function generateEmptyWordReport() {
  return `
<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bug Report</title>
<style>
body { font-family: Calibri, Arial, sans-serif; margin: 40px; line-height: 1.6; }
h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
</style>
</head>
<body>
<h1>🐛 Bug Report</h1>
<p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
<p><strong>No UI interaction steps recorded.</strong></p>
</body>
</html>`;
}

/**
 * Download Word document content as file
 */
function downloadRTFDocument(content, customFilename = null) {
  const filename = customFilename || `bug-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.rtf`;
  
  // Use data URL with RTF MIME type for proper RTF document download
  const dataUrl = 'data:application/rtf;charset=utf-8,' + encodeURIComponent(content);
  
  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: true
  }, function(downloadId) {
    if (chrome.runtime.lastError) {
      console.error('Download failed:', chrome.runtime.lastError);
    } else {
      console.log('RTF document download started:', downloadId);
    }
  });
}

/**
 * Download markdown content as file (kept for backward compatibility)
 */
function downloadMarkdown(content, customFilename = null) {
  const filename = customFilename || `bug-report-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.md`;
  
  // Use data URL instead of URL.createObjectURL for service worker compatibility
  const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(content);
  
  chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: true
  }, function(downloadId) {
    if (chrome.runtime.lastError) {
      console.error('Download failed:', chrome.runtime.lastError);
    } else {
      console.log('Download started:', downloadId);
    }
  });
}

// Persistent recording state across navigation
let persistentState = {
  isRecording: false,
  sessionId: null,
  startTime: null,
  lastReport: null
};

/**
 * Extension installation/startup
 */
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Bug Capturer Extension installed:', details.reason);
  // Initialize persistent state
  chrome.storage.local.set({ 
    isRecording: false,
    sessionActive: false 
  });
});

// Handle tab updates to maintain recording state across navigation
// Throttle tab update events to prevent excessive processing
let tabUpdateTimeout = null;
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && persistentState.isRecording) {
    // Debounce rapid tab updates
    if (tabUpdateTimeout) {
      clearTimeout(tabUpdateTimeout);
    }
    
    tabUpdateTimeout = setTimeout(async () => {
      try {
        // Reduced delay for faster state restoration
        await restoreRecordingStateWithRetry(tabId, 3);
      } catch (error) {
        console.error('Error restoring recording state:', error);
      }
      tabUpdateTimeout = null;
    }, 300); // Reduced from 1000ms to 300ms
  }
});

/**
 * Restore recording state with retry mechanism for better cross-tab sync
 */
async function restoreRecordingStateWithRetry(tabId, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'restore-recording-state',
        sessionId: persistentState.sessionId,
        startTime: persistentState.startTime,
        isRecording: true
      });
      console.log(`Recording state restored after navigation (attempt ${attempt})`);
      return; // Success, exit retry loop
    } catch (err) {
      console.log(`Attempt ${attempt} failed, content script not ready`);
      
      if (attempt === maxRetries) {
        // Last attempt: try manual injection
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content-script.js']
          });
          
          // Final attempt after injection
          setTimeout(async () => {
            try {
              await chrome.tabs.sendMessage(tabId, {
                type: 'restore-recording-state',
                sessionId: persistentState.sessionId,
                startTime: persistentState.startTime,
                isRecording: true
              });
              console.log('Recording state restored after manual injection');
            } catch (retryErr) {
              console.warn('Failed to restore state after manual injection:', retryErr);
            }
          }, 200); // Reduced delay
        } catch (injectionErr) {
          console.warn('Failed to inject content script:', injectionErr);
        }
      } else {
        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  }
}
