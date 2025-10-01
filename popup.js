let allSteps = [];
let lastStepCount = 0;
let autoRefreshInterval = null;
let lastLoadTime = 0;
const LOAD_THROTTLE_MS = 1000; // Minimum 1 second between loads

// Track report downloads to prevent premature data clearing
let reportDownloadTracker = {
  wordReportDownloaded: false,
  tvdReportDownloaded: false,
  reset() {
    this.wordReportDownloaded = false;
    this.tvdReportDownloaded = false;
  },
  shouldClearData() {
    return this.wordReportDownloaded && this.tvdReportDownloaded;
  },
  markReportDownloaded(reportType) {
    if (reportType === 'word') {
      this.wordReportDownloaded = true;
    } else if (reportType === 'tvd') {
      this.tvdReportDownloaded = true;
    }
    
    // Auto-clear data only when both reports are downloaded
    if (this.shouldClearData()) {
      setTimeout(() => {
        clearSteps(true);
        clearAllScreenshots(true);
        this.reset(); // Reset tracker for next session
      }, 1000);
    }
  }
};

/**
 * Get the current/latest URL from the background script
 * Falls back to stored current URL if tracking is not available
 */
async function getCurrentUrl() {
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'get-current-tab-url' });
    if (response && response.url) {
      return response.url;
    }
  } catch (error) {
    console.warn('Failed to get current URL from background:', error);
  }
  
  // Fallback to stored current URL
  try {
    const storedData = await chrome.storage.local.get(['bc_current_url']);
    if (storedData.bc_current_url) {
      return storedData.bc_current_url;
    }
  } catch (error) {
    console.warn('Failed to get stored current URL:', error);
  }
  
  // Final fallback to first step URL if no current URL is available
  const firstStep = allSteps.find(step => step.url);
  return firstStep?.url || 'Unknown URL';
}


// DOM elements
const activateBtn = document.getElementById('activate-btn');
const refreshBtn = document.getElementById('refresh-btn');
const clearBtn = document.getElementById('clear-btn');
const exportBtn = document.getElementById('export-btn');
const tvdBtn = document.getElementById('tvd-btn');

const stopBtn = document.getElementById('stop-btn');
const toggleBtn = document.getElementById('toggle-btn');
// Advanced Screenshot Widget Elements
const screenshotWidget = document.getElementById('screenshot-widget');
const screenshotTriggerBtn = document.getElementById('screenshot-trigger-btn');
const screenshotPanel = document.getElementById('screenshot-panel');
const closeScreenshotPanel = document.getElementById('close-screenshot-panel');
const captureCustomBtn = document.getElementById('capture-custom-btn');
const captureFullpageBtn = document.getElementById('capture-fullpage-btn');
const galleryGrid = document.getElementById('gallery-grid');
const clearScreenshots = document.getElementById('clear-screenshots');
const screenshotModal = document.getElementById('screenshot-modal');
const modalClose = document.getElementById('modal-close');
const modalImage = document.getElementById('modal-image');
const modalPrev = document.getElementById('modal-prev');
const modalNext = document.getElementById('modal-next');
const downloadScreenshot = document.getElementById('download-screenshot');
const copyScreenshot = document.getElementById('copy-screenshot');
const deleteScreenshot = document.getElementById('delete-screenshot');
const searchBox = document.getElementById('search-box');
const stepsContainer = document.getElementById('steps-container');
const stepsHeader = document.getElementById('steps-header');
const toggleStepsBtn = document.getElementById('toggle-steps');
const status = document.getElementById('status');

// Extension state
let isExtensionActive = false;
let screenshots = []; // Store captured screenshots
let currentScreenshotIndex = -1; // For modal navigation
let stepsCollapsed = false; // Track steps container state

/**
 * Deduplicate screenshots based on dataURL or timestamp
 * @param {Array} screenshots - Array of screenshot objects
 * @returns {Array} Deduplicated screenshots
 */
function deduplicateScreenshots(screenshots) {
  if (!screenshots || screenshots.length === 0) return [];
  
  const seen = new Set();
  const uniqueScreenshots = [];
  
  screenshots.forEach(screenshot => {
    // Use dataURL as primary identifier, fallback to timestamp + description
    const identifier = screenshot.dataURL || screenshot.dataUrl || 
                      `${screenshot.timestamp}_${screenshot.description || screenshot.filename || ''}`;
    
    if (!seen.has(identifier)) {
      seen.add(identifier);
      uniqueScreenshots.push(screenshot);
    }
  });
  
  return uniqueScreenshots;
}

// Custom screenshot selection state - moved to content script

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}


/**
 * Calculate step statistics
 * Only counts UI interactions, excludes console and performance events
 */
function calculateStats(steps) {
  // Filter out console, performance, focus, and blur events from step count
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && 
    step.type !== 'performance' &&
    step.meta?.action !== 'focus' &&
    step.meta?.action !== 'blur'
  );
  
  const stats = {
    total: uiSteps.length,
    error: 0,
    warning: 0,
    success: 0,
    form: 0,
    click: 0,
    navigation: 0
  };
  
  uiSteps.forEach(step => {
    const action = step.meta?.action || '';
    
    // Count by action type
    if (action === 'click') stats.click++;
    else if (action === 'navigation') stats.navigation++;
    else if (['input', 'select', 'submit'].includes(action)) stats.form++;
    else if (action === 'error') stats.error++;
    else if (action === 'warning') stats.warning++;
    else if (action === 'success') stats.success++;
  });
  
  return stats;
}

/**
 * Render step statistics
 * Only shows UI interaction statistics
 */
function renderStats(steps) {
  const stats = calculateStats(steps);
  
  return `
    <div class="stats">
      <div class="stat-item">UI Steps: ${stats.total}</div>
      ${stats.click > 0 ? `<div class="stat-item">Clicks: ${stats.click}</div>` : ''}
      ${stats.form > 0 ? `<div class="stat-item">Form: ${stats.form}</div>` : ''}
      ${stats.navigation > 0 ? `<div class="stat-item">Navigation: ${stats.navigation}</div>` : ''}
      ${stats.error > 0 ? `<div class="stat-item error">Errors: ${stats.error}</div>` : ''}
      ${stats.warning > 0 ? `<div class="stat-item warning">Warnings: ${stats.warning}</div>` : ''}
      ${stats.success > 0 ? `<div class="stat-item success">Success: ${stats.success}</div>` : ''}
    </div>
  `;
}


/**
 * Render steps with optional filtering
 * Only shows UI interactions by default, excludes console and performance events
 */
function renderSteps(steps = allSteps, filter = '') {
  // Filter out console, performance, focus, and blur events by default
  let filteredSteps = steps.filter(step => 
    step.type !== 'console' && 
    step.type !== 'performance' &&
    step.meta?.action !== 'focus' &&
    step.meta?.action !== 'blur'
  );
  
  // Apply text filter
  if (filter) {
    filteredSteps = filteredSteps.filter(step => 
      step.url.toLowerCase().includes(filter.toLowerCase()) ||
      step.text.toLowerCase().includes(filter.toLowerCase()) ||
      step.selector.toLowerCase().includes(filter.toLowerCase()) ||
      (step.meta?.action || '').toLowerCase().includes(filter.toLowerCase())
    );
  }
  
  
  if (filteredSteps.length === 0) {
    stepsContainer.innerHTML = '<div class="no-steps">🔍 No UI interaction steps found. Try adjusting your filter or refresh to load steps.</div>';
    return;
  }
  
  const statsHtml = renderStats(filteredSteps);
  const stepsHtml = filteredSteps.map((step, index) => {
    const readableDescription = formatStepDirectly(step);
    
    return `
      <div class="step-item clean text-overflow-handle" 
           aria-label="Step ${index + 1}: ${readableDescription}">
        <div class="step-clean-description long-text">
          ${index + 1}. ${readableDescription}
        </div>
      </div>
    `;
  }).join('');
  
  stepsContainer.innerHTML = statsHtml + stepsHtml;
}

/**
 * Load steps from background script
 */
async function loadSteps(silent = false) {
  if (!isExtensionActive) {
    stepsContainer.innerHTML = '<div class="no-steps">Extension deactivated. Click Activate to start recording.</div>';
    return;
  }
  
  // Throttle calls to prevent excessive loading
  const now = Date.now();
  if (now - lastLoadTime < LOAD_THROTTLE_MS) {
    return;
  }
  lastLoadTime = now;
  
  try {
    if (!silent) {
      refreshBtn.disabled = true;
      status.textContent = 'Loading...';
      showLoadingSkeleton();
    }
    
    const response = await chrome.runtime.sendMessage({ cmd: 'get-steps' });
    
    if (response.ok) {
      const newSteps = response.steps || [];
      
      // Only update UI if steps have changed (using length and last step timestamp for performance)
      const hasLengthChanged = newSteps.length !== allSteps.length;
      const hasNewSteps = hasLengthChanged || (newSteps.length > 0 && allSteps.length > 0 && 
        newSteps[newSteps.length - 1]?.time !== allSteps[allSteps.length - 1]?.time);
      
      if (hasNewSteps) {
        allSteps = newSteps;
        renderSteps();
        lastStepCount = allSteps.length;
      }
      
      if (!silent) {
        status.textContent = `Loaded ${allSteps.length} steps`;
      }
    } else {
      if (!silent) {
        status.textContent = 'Error loading steps: ' + (response.error || 'Unknown error');
      }
    }
  } catch (error) {
    if (!silent) {
      status.textContent = 'Failed to load steps: ' + error.message;
    }
  } finally {
    if (!silent) {
      refreshBtn.disabled = false;
    }
  }
}

/**
 * Clear all stored steps
 */
async function clearSteps(skipConfirmation = false) {
  if (!skipConfirmation && !confirm('Clear all captured steps? This cannot be undone.')) {
    return;
  }

  try {
    // Clear steps from storage
    await chrome.runtime.sendMessage({ cmd: 'clear-steps' });
    
    // STOP RECORDING to prevent session restoration
    await chrome.runtime.sendMessage({ 
      cmd: 'update-recording-state', 
      isRecording: false,
      sessionId: null,
      startTime: null
    });
    
    // Clear local state
    allSteps = [];
    lastStepCount = 0;
    
    // Update UI
    renderSteps([]);
    
    // Stop auto-refresh to prevent immediate reload
    stopAutoRefresh();
    
    // Reset report download tracker
    reportDownloadTracker.reset();
    
    // Clear search
    if (searchBox) searchBox.value = '';
    
    if (!skipConfirmation) {
      status.textContent = 'Steps cleared and recording stopped';
      status.className = 'status success';
    }
    
    console.log('Steps cleared and recording stopped');
  } catch (error) {
    console.error('Error clearing steps:', error);
    if (!skipConfirmation) {
      status.textContent = 'Failed to clear steps: ' + error.message;
      status.className = 'status error';
    }
  } finally {
    if (clearBtn) clearBtn.disabled = false;
    // Reset status after 3 seconds
    if (!skipConfirmation) {
      setTimeout(() => {
        status.textContent = '';
        status.className = 'status';
      }, 3000);
    }
  }
}

/**
 * Export steps as Word document file
 */
async function exportRTFDocument() {
  if (!isExtensionActive) {
    status.textContent = 'Extension must be activated first';
    status.className = 'status error';
    return;
  }
  
  if (allSteps.length === 0) {
    status.textContent = 'No steps to export';
    return;
  }
  
  // Get current URL and generate RTF content
  const currentUrl = await getCurrentUrl();
  const title = `Bug Report - ${new Date().toLocaleDateString()}`;
  const rtfContent = generateRTFReportHTML(allSteps, title, currentUrl);
  
  const blob = new Blob([rtfContent], { type: 'application/rtf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bug-report-${Date.now()}.rtf`;
  a.click();
  URL.revokeObjectURL(url);
  
  status.textContent = 'RTF document exported';
}

/**
 * Generate RTF content for document
 */
function generateRTFReportHTML(steps, title, currentUrl = 'Unknown URL') {
  // Filter out console and performance events
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && step.type !== 'performance'
  );
  
  // Find screenshots in steps
  const screenshots = uiSteps.filter(step => step.type === 'screenshot' && step.dataURL);
  
  // Calculate statistics
  const stats = calculateStats(uiSteps);
  
  // Generate RTF content
  let rtfContent = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}
{\\colortbl;\\red0\\green0\\blue0;}
\\f0\\fs24
{\\b\\fs28 🐛 ${title}}\\par
\\par
{\\b\\fs26 📊 Statistics}\\par
\\par
Total UI Steps: ${stats.total}\\par
Click Actions: ${stats.click}\\par
Form Interactions: ${stats.form}\\par
Navigation Actions: ${stats.navigation}\\par
Duration: ${Math.round((Date.now() - (allSteps[0]?.time || Date.now())) / 1000)} seconds\\par
Generated: ${new Date().toLocaleString()}\\par
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
    const stepDescription = formatStepDirectly(step);
    if (stepDescription && !stepDescription.includes('Captured screenshot')) {
      rtfContent += `${index + 1}. ${stepDescription}\\par
\\par`;
    }
  });
  
  rtfContent += `{\\b\\fs26 ✅ Expected Results}\\par
\\par
[Please fill in the expected behavior here]\\par
\\par
{\\b\\fs26 ❌ Actual Results}\\par
\\par
URL: ${currentUrl}\\par
Steps performed: ${stats.total} actions recorded\\par
Details: See "Steps to Reproduce" section above for detailed actions\\par
[Please describe what actually happened and any error messages or unexpected behavior]\\par
\\par
{\\b\\fs26 🖥️ Environment}\\par
\\par
URL: ${currentUrl}\\par
Browser: ${navigator.userAgent.split(' ')[0]}\\par
Platform: ${navigator.platform}\\par
Generated: ${new Date().toLocaleString()}\\par
Report Type: Bug Context Capturer\\par
}`;
  
  return rtfContent;
}

async function generateComprehensiveReport() {
  if (!isExtensionActive) {
    status.textContent = 'Extension must be activated first';
    status.className = 'status error';
    return;
  }
  
  if (allSteps.length === 0) {
    status.textContent = 'No steps to generate report';
    return;
  }
  
  // Convert steps to readable format (similar to test-v3.html)
  const readableSteps = convertStepsToReadable(allSteps);
  
  // Get the actual tab URL instead of extension URL
  let actualUrl = 'Unknown URL';
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'get-current-tab-url' });
    if (response && response.url) {
      actualUrl = response.url;
    }
  } catch (error) {
    console.warn('Failed to get actual tab URL:', error);
  }
  
  // Get comprehensive metadata
  const metadata = {
    'URL': actualUrl,
    'Browser': navigator.userAgent.split(' ')[0],
    'Platform': navigator.platform,
    'Language': navigator.language,
    'Screen': `${screen.width}x${screen.height}`,
    'Viewport': `${window.innerWidth}x${window.innerHeight}`,
    'Pixel Ratio': window.devicePixelRatio,
    'Online': navigator.onLine ? 'Yes' : 'No',
    'Cookies': navigator.cookieEnabled ? 'Enabled' : 'Disabled',
    'Time Zone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'Steps Recorded': allSteps.length,
    'Generated': new Date().toLocaleString()
  };
  
  // Calculate statistics
  const stats = calculateStats(allSteps);
  
  // Show report in modal instead of downloading
  showBugModal(allSteps, metadata, stats, readableSteps);
}

function convertStepsToReadable(steps) {
  if (!steps || steps.length === 0) {
    return 'No steps recorded.';
  }
  
  // Filter out console, performance, focus, and blur events
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && 
    step.type !== 'performance' &&
    step.meta?.action !== 'focus' &&
    step.meta?.action !== 'blur'
  );
  
  if (uiSteps.length === 0) {
    return 'No UI interaction steps recorded.';
  }
  
  const convertedSteps = [];
  
  uiSteps.forEach((step, index) => {
    const converted = formatStepDirectly(step);
    if (converted) {
      convertedSteps.push(`${index + 1}. ${converted}`);
    }
  });
  
  return convertedSteps.join('\n');
}

function formatStepDirectly(step) {
  // Validate step object
  if (!step || typeof step !== 'object') {
    return 'Invalid step data';
  }
  
  // Ensure step has basic structure
  if (!step.meta && !step.type && !step.text && !step.selector) {
    return 'Incomplete step data';
  }
  
  const action = String(step.meta?.action || step.type || 'action');
  const target = step.text || step.selector || 'element';
  const details = step.meta?.details || '';
  
  // Skip focus/blur events as they're too verbose
  if (['focus', 'blur'].includes(action)) {
    return null; // This will be filtered out
  }
  
  switch (action) {
    case 'click':
      const clickTarget = getMeaningfulElementName(target, step);
      // Check if this is a sensitive field click
      if (clickTarget && clickTarget.includes('[REDACTED]')) {
        return 'Clicked on a Sensitive field';
      }
      return `Clicked ${addProperArticle(clickTarget)}`;
    case 'input':
      const fieldName = getMeaningfulElementName(target, step);
      let value = details || step.meta?.value || '';
      
      // Remove duplication patterns like "Entered "admin" in Username"
      if (value.startsWith('Entered "') && value.includes('" in ')) {
        const match = value.match(/^Entered "([^"]+)" in (.+)$/);
        if (match) {
          value = match[1]; // Extract just the actual value
        }
      }
      
      if (value && value.trim() !== '' && value !== '[REDACTED]') {
        return `Entered "${value}" into ${addProperArticle(fieldName)}`;
      } else if (value === '[REDACTED]') {
        return `Entered sensitive data into ${addProperArticle(fieldName)}`;
      } else {
        return `Cleared ${addProperArticle(fieldName)}`;
      }
    case 'select':
      const selectTarget = getMeaningfulElementName(target, step);
      return `Selected "${details}" from ${addProperArticle(selectTarget)}`;
    case 'submit':
      const submitButtonName = getMeaningfulElementName(target, step);
      if (submitButtonName && submitButtonName !== 'element' && submitButtonName !== 'button') {
        return `User clicked on "${submitButtonName}" page`;
      }
      return `Submitted the form`;
    case 'hover':
      return `Hovered over ${addProperArticle(getMeaningfulElementName(target, step))}`;
    case 'scroll':
      if (details && details.includes('down')) {
        return `Scrolled down on the page`;
      } else if (details && details.includes('up')) {
        return `Scrolled up on the page`;
      } else {
        return `Scrolled on the page`;
      }
    case 'navigation':
      // Prioritize step.url (current URL) over step.text (which may contain old URL)
      if (step.url) {
        return `Navigated to a new page: ${step.url}`;
      }
      // Fallback: Extract URL from step.text, step.meta.details, or target
      const navigationText = step.text || step.meta?.details || target || '';
      if (navigationText && navigationText.includes('Navigated to ')) {
        const url = navigationText.replace('Navigated to ', '');
        return `Navigated to a new page: ${url}`;
      }
      return `Navigated to a new page`;
    case 'keypress':
      const keyText = step.text || 'a key';
      if (keyText === 'Enter') {
        return `Pressed Enter`;
      } else if (keyText === 'Tab') {
        return `Pressed Tab`;
      } else {
        return `Pressed ${keyText}`;
      }
    case 'change':
      return `Modified ${addProperArticle(getMeaningfulElementName(target, step))}`;
    case 'toggle':
      return `Toggled ${addProperArticle(getMeaningfulElementName(target, step))}`;
    case 'screenshot-custom':
    case 'screenshot':
      return `Captured a screenshot`;
    case 'console':
      return `Console ${step.meta?.level || 'log'}: ${target}`;
    case 'performance':
      return `Performance event: ${target}`;
    default:
      return `Performed ${action} on ${addProperArticle(getMeaningfulElementName(target, step))}`;
  }
}

function getMeaningfulElementName(target, step) {
  if (!target) return 'the page';
  
  // If target contains a colon (from our improved getSafeText), extract the meaningful part
  if (target.includes(':')) {
    const parts = target.split(':');
    const identifier = parts[0].trim();
    return identifier;
  }
  
  // If it's a CSS selector, extract the meaningful part
  if (target.includes('>') && target.includes('.')) {
    const parts = target.split('>').map(part => part.trim());
    const lastPart = parts[parts.length - 1];
    
    // Clean up the last part
    let cleaned = lastPart
      .replace(/^[a-zA-Z]+\./, '') // Remove tag name
      .replace(/\[.*?\]/g, '') // Remove attributes
      .replace(/\s+/g, ' ')
      .trim();
    
    if (cleaned) {
      return cleaned;
    }
  }
  
  // For non-selector text, clean it up
  let cleaned = target
    .replace(/\[object \w+\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^(TEXTAREA|INPUT|BUTTON|DIV|SPAN)\s*/i, '');
  
  // Extract meaningful identifiers
  const lowerCleaned = cleaned.toLowerCase();
  
  // Enhanced button detection with better text extraction
  if (lowerCleaned.includes('submit')) {
    return 'Submit button';
  } else if (lowerCleaned.includes('login') || lowerCleaned.includes('log in') || lowerCleaned.includes('sign in')) {
    return 'Login button';
  } else if (lowerCleaned.includes('signup') || lowerCleaned.includes('sign up')) {
    return 'Sign Up button';
  } else if (lowerCleaned.includes('register')) {
    return 'Register button';
  } else if (lowerCleaned.includes('save')) {
    return 'Save button';
  } else if (lowerCleaned.includes('cancel')) {
    return 'Cancel button';
  } else if (lowerCleaned.includes('delete') || lowerCleaned.includes('remove')) {
    return 'Delete button';
  } else if (lowerCleaned.includes('edit')) {
    return 'Edit button';
  } else if (lowerCleaned.includes('add') || lowerCleaned.includes('create')) {
    return 'Add button';
  } else if (lowerCleaned.includes('search')) {
    return 'Search button';
  } else if (lowerCleaned.includes('close')) {
    return 'Close button';
  } else if (lowerCleaned.includes('next')) {
    return 'Next button';
  } else if (lowerCleaned.includes('previous') || lowerCleaned.includes('prev')) {
    return 'Previous button';
  } else if (lowerCleaned.includes('back')) {
    return 'Back button';
  } else if (lowerCleaned.includes('continue')) {
    return 'Continue button';
  } else if (lowerCleaned.includes('confirm')) {
    return 'Confirm button';
  } else if (lowerCleaned.includes('button')) {
    return cleaned.includes('button') ? cleaned : `${cleaned} button`;
  } else if (lowerCleaned.includes('username') || lowerCleaned.includes('user name')) {
    return 'username field';
  } else if (lowerCleaned.includes('password')) {
    return 'password field';
  } else if (lowerCleaned.includes('email')) {
    return 'email field';
  } else if (lowerCleaned.includes('phone') || lowerCleaned.includes('mobile')) {
    return 'phone number field';
  } else if (lowerCleaned.includes('textarea')) {
    return 'text area';
  } else if (lowerCleaned.includes('input')) {
    return 'input field';
  } else if (lowerCleaned.includes('first name') || lowerCleaned.includes('firstname')) {
    return 'First Name field';
  } else if (lowerCleaned.includes('last name') || lowerCleaned.includes('lastname')) {
    return 'Last Name field';
  } else if (lowerCleaned.includes('dropdown') || lowerCleaned.includes('select')) {
    return 'dropdown menu';
  } else if (lowerCleaned.includes('checkbox')) {
    return 'checkbox';
  } else if (lowerCleaned.includes('radio')) {
    return 'radio button';
  } else if (lowerCleaned.includes('link')) {
    return 'link';
  } else if (lowerCleaned.includes('menu')) {
    return 'menu';
  } else if (lowerCleaned.includes('modal') || lowerCleaned.includes('dialog')) {
    return 'modal dialog';
  }
  
  // Return cleaned text
  cleaned = cleaned.trim();
  if (!cleaned) return 'element';
  
  return cleaned;
}

function cleanTarget(target) {
  return getMeaningfulElementName(target);
}

// Helper function to add appropriate articles and improve readability
function addProperArticle(text) {
  if (!text || text.trim() === '') return 'the element';
  
  const trimmed = text.trim();
  const lowerText = trimmed.toLowerCase();
  
  // Don't add articles if text already has them
  if (lowerText.startsWith('the ') || lowerText.startsWith('a ') || lowerText.startsWith('an ')) {
    return trimmed;
  }
  
  // Use 'the' for specific UI elements
  if (lowerText.includes('field') || lowerText.includes('button') || lowerText.includes('form') || 
      lowerText.includes('menu') || lowerText.includes('page') || lowerText.includes('section') ||
      lowerText.includes('panel') || lowerText.includes('tab') || lowerText.includes('header') ||
      lowerText.includes('footer') || lowerText.includes('sidebar') || lowerText.includes('navbar')) {
    return `the ${trimmed}`;
  }
  
  // Add 'an' before vowels, 'a' before consonants for general elements
  const firstChar = lowerText.charAt(0);
  if (['a', 'e', 'i', 'o', 'u'].includes(firstChar)) {
    return `an ${trimmed}`;
  } else {
    return `a ${trimmed}`;
  }
}

function redactSensitiveData(value) {
  if (!value || typeof value !== 'string') return value;
  
  // Redact common sensitive patterns
  return value
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD_REDACTED]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]')
    .replace(/password|pwd|pass/gi, '[PASSWORD_REDACTED]');
}

/**
 * Show bug report in modal format (similar to test-v3.html)
 */
function showBugModal(steps, metadata, stats, readableSteps) {
  // Remove existing modal if present
  const existingModal = document.getElementById('bug-report-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Create modal overlay
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'bug-report-modal';
  modalOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.95);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  `;
  
  // Create modal content
  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';
  modalContent.style.cssText = `
    background: linear-gradient(135deg, #000000 0%, #1a1a1a 100%) !important;
    color: #ffffff !important;
    border-radius: 20px;
    width: 95%;
    max-width: 800px;
    max-height: 95%;
    overflow-y: auto;
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.1);
    position: relative;
    z-index: 2147483648;
    border: 1px solid rgba(255, 255, 255, 0.2);
    animation: modalFadeIn 0.4s ease-out;
    word-wrap: break-word;
    overflow-wrap: break-word;
  `;
  
  // Add CSS animation and styling for smooth appearance
  if (!document.getElementById('modal-styles')) {
    const style = document.createElement('style');
    style.id = 'modal-styles';
    style.textContent = `
      @keyframes modalFadeIn {
        from { 
          opacity: 0; 
          transform: scale(0.9) translateY(-30px); 
        }
        to { 
          opacity: 1; 
          transform: scale(1) translateY(0); 
        }
      }
      
      /* Custom scrollbar for modal */
      #bug-report-modal .modal-content::-webkit-scrollbar {
        width: 8px;
      }
      
      #bug-report-modal .modal-content::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
      }
      
      #bug-report-modal .modal-content::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 4px;
      }
      
      #bug-report-modal .modal-content::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
      }
      
      /* Enhanced button styles */
      .modal-btn {
        background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%) !important;
        color: white !important;
        border: 1px solid rgba(255, 255, 255, 0.2) !important;
        padding: 12px 24px !important;
        border-radius: 12px !important;
        cursor: pointer !important;
        font-weight: 600 !important;
        font-size: 14px !important;
        transition: all 0.3s ease !important;
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3) !important;
      }
      
      .modal-btn:hover {
        transform: translateY(-2px) scale(1.02) !important;
        box-shadow: 0 8px 20px rgba(59, 130, 246, 0.5) !important;
      }
      
      .modal-btn:active {
        transform: translateY(0) scale(0.98) !important;
      }
      
      .close-modal-btn {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
        color: white !important;
        border: 1px solid rgba(255, 255, 255, 0.2) !important;
        padding: 8px !important;
        border-radius: 50% !important;
        cursor: pointer !important;
        font-size: 18px !important;
        width: 40px !important;
        height: 40px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        transition: all 0.3s ease !important;
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3) !important;
      }
      
      .close-modal-btn:hover {
        transform: scale(1.1) !important;
        box-shadow: 0 6px 16px rgba(239, 68, 68, 0.5) !important;
      }
      
      /* Enhanced textarea styling */
      #bug-report-modal textarea {
        outline: none !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        line-height: 1.5 !important;
      }
      
      #bug-report-modal textarea::placeholder {
        color: rgba(255, 255, 255, 0.5) !important;
        font-style: italic !important;
      }
      
      /* Section headers with better spacing */
      #bug-report-modal h3 {
        position: relative;
        padding-left: 12px;
      }
      
      #bug-report-modal h3::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 4px;
        height: 24px;
        background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
        border-radius: 2px;
      }
      
      /* Force black background and white text for modal */
      #bug-report-modal {
        background: linear-gradient(135deg, #000000 0%, #1a1a1a 100%) !important;
        color: #ffffff !important;
      }
      
      #bug-report-modal * {
        color: inherit !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
        box-sizing: border-box !important;
      }
      
      #bug-report-modal h1, #bug-report-modal h2, #bug-report-modal h3, #bug-report-modal h4, #bug-report-modal h5, #bug-report-modal h6 {
        color: #ffffff !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
      }
      
      #bug-report-modal p, #bug-report-modal div, #bug-report-modal span {
        color: #ffffff !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
      }
      
      /* Override any white backgrounds */
      #bug-report-modal .modal-content {
        background: linear-gradient(135deg, #000000 0%, #1a1a1a 100%) !important;
        color: #ffffff !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
      }
    `;
    document.head.appendChild(style);
  }
  
  // Generate HTML content
  modalContent.innerHTML = generateModalHTML(steps, metadata, stats, readableSteps);
  
  modalOverlay.appendChild(modalContent);
  document.body.appendChild(modalOverlay);
  
  // Add event listeners
  setupModalEventListeners(modalOverlay);
}

/**
 * Generate HTML content for the modal
 */
function generateModalHTML(steps, metadata, stats, readableSteps) {
  const timestamp = new Date().toLocaleString();
  
  // Generate title based on URL
  const url = metadata.URL || 'Unknown URL';
  let title = 'Bug Report';
  try {
    const domain = new URL(url).hostname;
    const path = new URL(url).pathname;
    title = `Issue on ${domain}`;
    if (path && path !== '/') {
      const pathParts = path.split('/').filter(p => p);
      if (pathParts.length > 0) {
        title += `/${pathParts[0]}`;
        if (pathParts.length > 1) {
          title += `/${pathParts[1]}`;
        }
      }
    }
  } catch (e) {
    // If URL parsing fails, use default title
  }
  
  // Find screenshots in steps and deduplicate them
  const allScreenshots = steps.filter(step => step.type === 'screenshot' && step.dataURL);
  const screenshots = deduplicateScreenshots(allScreenshots);
  
  // Create action summary for Actual Results
  const keyActions = steps.filter(step => 
    step.type !== 'console' && 
    step.type !== 'performance' && 
    !['screenshot', 'focus', 'blur'].includes(step.meta?.action || step.type)
  );
  
  const actionSummary = keyActions.map((step, index) => {
    const action = step.meta?.action || step.type || 'action';
    const target = step.text || step.selector || 'element';
    
    switch (action) {
      case 'click':
        return `Clicked on ${target}`;
      case 'input':
        return `Entered data in ${target}`;
      case 'select':
        return `Selected option from ${target}`;
      case 'submit':
        return `Submitted form`;
      case 'navigation':
        return `Navigated to ${target}`;
      case 'keypress':
        return `Pressed ${step.text || 'key'}`;
      case 'change':
        return `Changed ${target}`;
      case 'toggle':
        return `Toggled ${target}`;
      default:
        return `Performed ${action} on ${target}`;
    }
  }).join(' → ');
  
  return `
    <div style="padding: 0; overflow-y: auto; background: linear-gradient(135deg, #000000 0%, #1a1a1a 100%); color: #ffffff;">
      <!-- Header Section -->
      <div style="padding: 20px 20px 16px; background: linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%); border-bottom: 1px solid rgba(255, 255, 255, 0.1); position: relative;">
        <button id="close-modal" class="close-modal-btn" style="position: absolute; top: 20px; right: 20px;">×</button>
        <div style="padding-right: 60px;">
          <h1 style="margin: 0; color: #ffffff !important; font-size: 20px; font-weight: 700; margin-bottom: 8px; text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3); word-wrap: break-word; overflow-wrap: break-word; line-height: 1.2;">🐛 ${title}</h1>
          <div style="color: rgba(255, 255, 255, 0.7) !important; font-size: 12px; font-weight: 500; word-wrap: break-word; overflow-wrap: break-word;">Bug Report - ${new Date().toLocaleString()}</div>
        </div>
      </div>
      
      <!-- Main Content -->
      <div style="padding: 20px; background: linear-gradient(135deg, #000000 0%, #1a1a1a 100%); color: #ffffff;">
        <!-- Statistics Section -->
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">📊 Statistics</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px;">
            <div style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(37, 99, 235, 0.1) 100%); padding: 16px; border-radius: 12px; text-align: center; border: 1px solid rgba(59, 130, 246, 0.3); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);">
              <div style="font-size: 20px; font-weight: 700; color: #60a5fa; margin-bottom: 4px;">${stats.total}</div>
              <div style="font-size: 11px; color: #93c5fd; font-weight: 600;">Total Steps</div>
            </div>
            <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(5, 150, 105, 0.1) 100%); padding: 16px; border-radius: 12px; text-align: center; border: 1px solid rgba(16, 185, 129, 0.3); box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);">
              <div style="font-size: 20px; font-weight: 700; color: #6ee7b7; margin-bottom: 4px;">${stats.click || 0}</div>
              <div style="font-size: 11px; color: #a7f3d0; font-weight: 600;">Clicks</div>
            </div>
            <div style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(217, 119, 6, 0.1) 100%); padding: 16px; border-radius: 12px; text-align: center; border: 1px solid rgba(245, 158, 11, 0.3); box-shadow: 0 4px 12px rgba(245, 158, 11, 0.2);">
              <div style="font-size: 20px; font-weight: 700; color: #fde047; margin-bottom: 4px;">${stats.form}</div>
              <div style="font-size: 11px; color: #fef3c7; font-weight: 600;">Form Actions</div>
            </div>
            <div style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(220, 38, 38, 0.1) 100%); padding: 16px; border-radius: 12px; text-align: center; border: 1px solid rgba(239, 68, 68, 0.3); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);">
              <div style="font-size: 20px; font-weight: 700; color: #fca5a5; margin-bottom: 4px;">${stats.error || 0}</div>
              <div style="font-size: 11px; color: #fecaca; font-weight: 600;">Errors</div>
            </div>
          </div>
        </div>
      
        <!-- Defect Screenshot Section -->
        ${screenshots.length > 0 ? `
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">📸 Defect Screenshot</h3>
          ${screenshots.map((screenshot, index) => {
            const filename = `screenshot${String(index + 1).padStart(2, '0')}.png`;
            return `
            <div style="margin-bottom: 20px; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 12px; overflow: hidden; background: rgba(255, 255, 255, 0.05); backdrop-filter: blur(10px);">
              <div style="padding: 16px; text-align: center; color: rgba(255, 255, 255, 0.8);">
                <div style="font-size: 12px; font-weight: 600; margin-bottom: 12px; word-wrap: break-word; overflow-wrap: break-word;">${screenshot.description || `Screenshot ${index + 1}`}</div>
                ${screenshot.dataURL ? `
                  <div style="border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; overflow: hidden; background: #000; max-width: 100%;">
                    <img src="${screenshot.dataURL}" 
                         style="width: 100%; height: auto; max-height: 300px; object-fit: contain; cursor: pointer; display: block;" 
                         onclick="this.style.maxHeight = this.style.maxHeight === 'none' ? '300px' : 'none'; this.style.objectFit = this.style.objectFit === 'contain' ? 'cover' : 'contain';"
                         title="Click to expand/collapse and toggle fit mode"
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                    <div style="display: none; padding: 30px 16px; text-align: center; color: rgba(255, 255, 255, 0.6);">
                      <div style="font-size: 32px; margin-bottom: 8px;">📸</div>
                      <div style="font-size: 10px;">Image failed to load</div>
                    </div>
                  </div>
                ` : `
                  <div style="padding: 30px 16px; text-align: center; color: rgba(255, 255, 255, 0.6);">
                    <div style="font-size: 32px; margin-bottom: 8px;">📸</div>
                    <div style="font-size: 10px;">No screenshot data available</div>
                  </div>
                `}
                <div style="font-size: 10px; color: rgba(255, 255, 255, 0.6); margin-top: 8px; word-wrap: break-word; overflow-wrap: break-word;">File: ./bug-report-assets/${filename}</div>
              </div>
            </div>
          `;
          }).join('')}
        </div>
        ` : ''}
      
        <!-- Steps to Reproduce Section -->
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">📝 Steps to Reproduce</h3>
          <div style="background: rgba(255, 255, 255, 0.05); color: #ffffff; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 12px; padding: 20px; max-height: 400px; overflow-y: auto; font-family: 'JetBrains Mono', 'Fira Code', monospace; white-space: pre-line; font-size: 11px; line-height: 1.4; backdrop-filter: blur(10px); word-wrap: break-word; overflow-wrap: break-word;">
            ${readableSteps}
          </div>
        </div>
      
        <!-- Expected Results Section -->
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">✅ Expected Results</h3>
          <textarea id="expected-results" 
                    placeholder="Please describe what should have happened..." 
                    style="width: 100%; min-height: 80px; padding: 12px; border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; resize: vertical; background: rgba(59, 130, 246, 0.1); color: #ffffff; backdrop-filter: blur(10px); transition: all 0.3s ease; line-height: 1.4;"
                    onfocus="this.style.borderColor='#60a5fa'; this.style.boxShadow='0 0 0 3px rgba(59, 130, 246, 0.2)'"
                    onblur="this.style.borderColor='rgba(59, 130, 246, 0.3)'; this.style.boxShadow='none'">
          </textarea>
        </div>
        
        <!-- Actual Results Section -->
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">❌ Actual Results</h3>
          <div style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(220, 38, 38, 0.1) 100%); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 16px; backdrop-filter: blur(10px); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);">
            <div style="margin-bottom: 12px; font-weight: 600; font-size: 12px; color: #fca5a5 !important; word-wrap: break-word; overflow-wrap: break-word; line-height: 1.3;">🌐 URL: ${url}</div>
            <div style="margin-bottom: 12px; font-weight: 600; font-size: 12px; color: #fca5a5 !important;">📊 Steps performed: ${stats.total} actions recorded</div>
            <div style="font-size: 11px; color: #fecaca !important; font-weight: 500; word-wrap: break-word; overflow-wrap: break-word; line-height: 1.3;">See "Steps to Reproduce" section above for detailed actions</div>
          </div>
          <textarea id="actual-results" 
                    placeholder="Please describe what actually happened, any error messages, or unexpected behavior..." 
                    style="width: 100%; min-height: 80px; padding: 12px; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; resize: vertical; background: rgba(239, 68, 68, 0.1); color: #ffffff; backdrop-filter: blur(10px); transition: all 0.3s ease; line-height: 1.4;"
                    onfocus="this.style.borderColor='#fca5a5'; this.style.boxShadow='0 0 0 3px rgba(239, 68, 68, 0.2)'"
                    onblur="this.style.borderColor='rgba(239, 68, 68, 0.3)'; this.style.boxShadow='none'">
          </textarea>
        </div>
      
        <!-- Environment Section -->
        <div style="margin-bottom: 32px;">
          <h3 style="margin: 0 0 20px 0; color: #ffffff !important; font-size: 16px; font-weight: 600; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);">🖥️ Environment</h3>
          <div style="background: linear-gradient(135deg, rgba(31, 41, 55, 0.8) 0%, rgba(17, 24, 39, 0.9) 100%); color: #f9fafb; border: 1px solid rgba(75, 85, 99, 0.5); border-radius: 12px; padding: 20px; backdrop-filter: blur(10px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; font-size: 11px;">
              ${Object.entries(metadata).map(([key, value]) => 
                `<div style="padding: 6px 0; border-bottom: 1px solid rgba(75, 85, 99, 0.3); word-wrap: break-word; overflow-wrap: break-word;"><strong style="color: #60a5fa; font-weight: 600;">${key}:</strong> <span style="color: #d1d5db; margin-left: 8px; word-wrap: break-word; overflow-wrap: break-word;">${value}</span></div>`
              ).join('')}
            </div>
          </div>
        </div>
        
        <!-- Action Buttons -->
        <div style="display: flex; gap: 12px; justify-content: flex-end; padding: 16px 0 0; border-top: 1px solid rgba(255, 255, 255, 0.1);">
          <button id="copy-report" class="modal-btn" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%) !important; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3) !important; font-size: 11px; padding: 8px 16px;">📋 Copy to Clipboard</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Setup event listeners for modal
 */
function setupModalEventListeners(modalOverlay) {
  // Close modal when clicking overlay
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.remove();
    }
  });
  
  // Close button
  const closeBtn = modalOverlay.querySelector('#close-modal');
  closeBtn.addEventListener('click', () => {
    modalOverlay.remove();
  });
  
  // Download button removed - use main interface Export Word button instead
  
  // Copy button
  const copyBtn = modalOverlay.querySelector('#copy-report');
  copyBtn.addEventListener('click', () => {
    copyReportToClipboard();
  });
  
  // ESC key to close
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      modalOverlay.remove();
      document.removeEventListener('keydown', handleKeyDown);
    }
  };
  document.addEventListener('keydown', handleKeyDown);
}

/**
 * Save screenshot as separate file and return the filename
 */
async function saveScreenshotAsFile(screenshot, index) {
  try {
    // Convert data URL to blob
    const response = await fetch(screenshot.dataURL);
    const blob = await response.blob();
    
    // Create filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `screenshot-${timestamp}-${index + 1}.png`;
    
    // Create download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bug-report-assets/${filename}`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
    return filename;
  } catch (error) {
    console.error('Error saving screenshot:', error);
    return null;
  }
}

/**
 * Download Word document report with embedded images
 * Only includes UI interactions, excludes console and performance events
 */
async function downloadWordDocumentReport() {
  try {
    // Use the background script to download Word report with embedded images
    const response = await chrome.runtime.sendMessage({
      cmd: 'download-report-with-images'
    });
    
    if (response && response.success) {
      status.textContent = `Word document downloaded with embedded images`;
      status.style.color = '#22c55e';
    } else {
      status.textContent = 'Failed to download Word document: ' + (response?.message || 'Unknown error');
      status.style.color = '#dc3545';
    }
  } catch (error) {
    console.error('Error downloading Word document:', error);
    status.textContent = 'Failed to download Word document: ' + error.message;
    status.style.color = '#dc3545';
  }
}









/**
 * TVD - Capture all screenshots from session and generate Word document
 */
async function generateTVDReport() {
  try {
    if (!isExtensionActive) {
      status.textContent = 'Extension must be activated first';
      status.className = 'status error';
      return;
    }

    if (allSteps.length === 0) {
      status.textContent = 'No steps to generate TVD report';
      status.className = 'status error';
      return;
    }

    // Show loading status
    status.textContent = 'Generating TVD report with all screenshots...';
    status.style.color = '#f97316';

    // Get all screenshots from the session and sort by timestamp (first at top, latest at bottom)
    const sessionScreenshots = screenshots.filter(screenshot => 
      screenshot.timestamp && screenshot.dataURL
    ).sort((a, b) => a.timestamp - b.timestamp);

    // Deduplicate screenshots to ensure only unique ones are included
    const uniqueScreenshots = deduplicateScreenshots(sessionScreenshots);

    if (uniqueScreenshots.length === 0) {
      status.textContent = 'No screenshots found in session';
      status.className = 'status error';
      return;
    }

    // Prepare screenshots data for TVD report (screenshots only)
    const screenshotData = uniqueScreenshots.map((screenshot, index) => ({
      filename: `screenshot-${String(index + 1).padStart(2, '0')}.png`,
      dataUrl: screenshot.dataURL,
      data: screenshot.dataURL,
      description: screenshot.description || `Screenshot ${index + 1}`,
      timestamp: screenshot.timestamp,
      type: screenshot.type || 'fullpage'
    }));

    // Initialize and use Word generator
    const wordGenerator = new WordReportGenerator();
    await wordGenerator.initialize();
    
    const filename = `tvd-report-${new Date().toISOString().slice(0, 10)}.docx`;
    const result = await wordGenerator.generateTVDReport('', screenshotData, {
      url: allSteps[0]?.url || 'Unknown URL',
      browser: navigator.userAgent,
      platform: navigator.platform,
      timestamp: new Date().toISOString(),
      totalScreenshots: uniqueScreenshots.length,
      totalSteps: allSteps.length
    }, filename);

    if (result.success) {
      status.textContent = `✅ TVD report generated with ${uniqueScreenshots.length} screenshots!`;
      status.className = 'status success';
      
      // Mark TVD report as downloaded
      reportDownloadTracker.markReportDownloaded('tvd');
    } else {
      status.textContent = `❌ Failed to generate TVD report: ${result.error}`;
      status.className = 'status error';
    }
  } catch (error) {
    console.error('Failed to generate TVD report:', error);
    status.textContent = `❌ Error generating TVD report: ${error.message}`;
    status.className = 'status error';
  }
}

/**
 * Generate professional Word document using client-side docx library
 */
async function generateWordDocumentReport() {
  const startTime = Date.now();
  let timeoutId;
  
  try {
    // Check if WordReportGenerator is available
    if (typeof WordReportGenerator === 'undefined') {
      status.textContent = 'Word generator not available. Please ensure the required libraries are loaded.';
      status.style.color = '#dc3545';
      return;
    }
    
    // Set a timeout for the entire operation (5 minutes)
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Report generation timed out after 5 minutes'));
      }, 5 * 60 * 1000);
    });
    
    // Check memory before starting
    if (performance.memory && performance.memory.usedJSHeapSize > 200 * 1024 * 1024) {
      throw new Error('Insufficient memory available for report generation');
    }

    const steps = allSteps;
    
    // Limit steps for memory safety
    const limitedSteps = steps.length > 100 ? steps.slice(0, 100) : steps;
    if (steps.length > 100) {
      console.warn(`Limited steps from ${steps.length} to 100 for memory safety`);
      status.textContent = `Processing ${limitedSteps.length} of ${steps.length} steps for memory optimization...`;
      status.style.color = '#ffc107';
    }
    
    const stats = calculateStats(limitedSteps);
    const readableSteps = convertStepsToReadable(limitedSteps);
    
    // Generate raw text report with error handling
    let rawText;
    try {
      rawText = await generateTextReportForWord(limitedSteps, stats, readableSteps);
    } catch (textError) {
      console.warn('Failed to generate detailed text report, using fallback:', textError);
      rawText = `Bug Report\n\nSteps: ${limitedSteps.length}\nGenerated: ${new Date().toLocaleString()}`;
    }
    
    // Prepare screenshots data and sort by timestamp (first at top, latest at bottom)
    const sortedScreenshots = screenshots.sort((a, b) => a.timestamp - b.timestamp);
    
    // Deduplicate screenshots to ensure only unique ones are included
    const uniqueScreenshots = deduplicateScreenshots(sortedScreenshots);
    
    // Limit screenshots for memory safety
    const limitedScreenshots = uniqueScreenshots.length > 20 ? uniqueScreenshots.slice(0, 20) : uniqueScreenshots;
    if (uniqueScreenshots.length > 20) {
      console.warn(`Limited screenshots from ${uniqueScreenshots.length} to 20 for memory safety`);
    }
    
    const screenshotData = limitedScreenshots.map((screenshot, index) => ({
      filename: `screenshot-${index + 1}.png`,
      dataUrl: screenshot.dataURL || screenshot.data,
      data: screenshot.dataURL || screenshot.data,
      description: screenshot.description || `Custom area screenshot ${index + 1}`,
      timestamp: screenshot.timestamp
    }));

    // Show loading status
    status.textContent = 'Generating Word document...';
    status.style.color = '#007cba';

    // Initialize and use Word generator with timeout
    const wordGenerator = new WordReportGenerator();
    
    try {
      await Promise.race([
        wordGenerator.initialize(),
        timeoutPromise
      ]);
    } catch (initError) {
      clearTimeout(timeoutId);
      throw new Error(`Word generator initialization failed: ${initError.message}`);
    }
    
    const filename = `bug-report-${new Date().toISOString().slice(0, 10)}.docx`;
    const currentUrl = await getCurrentUrl();
    
    // Generate report with timeout
    const result = await Promise.race([
      wordGenerator.generateBugReport(rawText, screenshotData, {
        url: currentUrl,
        browser: navigator.userAgent,
        platform: navigator.platform,
        timestamp: new Date().toISOString()
      }, filename),
      timeoutPromise
    ]);
    
    clearTimeout(timeoutId);

    if (result.success) {
      const duration = Date.now() - startTime;
      console.log(`Word document generated successfully in ${duration}ms`);
      status.textContent = '✅ Word document generated and downloaded successfully!';
      status.className = 'status success';
      
      // Mark Word report as downloaded
      reportDownloadTracker.markReportDownloaded('word');
    } else {
      throw new Error(result.error || 'Unknown error during report generation');
    }
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Failed to generate Word document:', error);
    
    // Provide specific error messages
    let errorMessage = '❌ Failed to generate Word document. ';
    if (error.message.includes('timeout')) {
      errorMessage += 'The operation took too long. Try reducing the number of captured steps or screenshots.';
    } else if (error.message.includes('memory') || error.message.includes('Memory')) {
      errorMessage += 'Not enough memory available. Try closing other tabs or applications.';
    } else if (error.message.includes('quota') || error.message.includes('storage')) {
      errorMessage += 'Storage quota exceeded. Please clear some data.';
    } else if (error.message.includes('initialization')) {
      errorMessage += 'Failed to initialize Word generator. Please refresh and try again.';
    } else {
      errorMessage += `${error.message}. Please try again or contact support if the issue persists.`;
    }
    
    status.textContent = errorMessage;
    status.className = 'status error';
    
    // Attempt cleanup
    try {
      if (window.gc) {
        window.gc();
        console.log('Triggered garbage collection after error');
      }
    } catch (gcError) {
      console.warn('Could not trigger garbage collection:', gcError);
    }
    
  } finally {
    // Final cleanup
    clearTimeout(timeoutId);
    
    // Reset status after a delay if it's still showing loading
    setTimeout(() => {
      if (status.textContent.includes('Generating')) {
        status.textContent = 'Ready';
        status.className = 'status';
      }
    }, 1000);
  }
}

/**
 * Generate text report specifically formatted for Word conversion
 */
async function generateTextReportForWord(steps, stats, readableSteps) {
  const reportUrl = await getCurrentUrl();
  
  let text = '';
  
  // Title
  if (reportUrl !== 'Unknown URL') {
    try {
      const urlObj = new URL(reportUrl);
      text += `Issue on ${urlObj.hostname.replace('www.', '')}\n\n`;
    } catch {
      text += `Issue on ${reportUrl}\n\n`;
    }
  } else {
    text += 'Bug Report\n\n';
  }
  
  // Statistics
  text += `📊 Statistics\n\n`;
  text += `- Total UI Steps: ${stats.total}\n`;
  text += `- Click Actions: ${stats.clicks}\n`;
  text += `- Form Interactions: ${stats.inputs}\n`;
  text += `- Navigation Actions: ${stats.navigation}\n`;
  text += `- Generated: ${new Date().toLocaleString()}\n\n`;
  
  // Steps to Reproduce
  text += `📝 Steps to Reproduce\n\n`;
  const stepLines = readableSteps.split('\n').filter(line => line.trim());
  stepLines.forEach((step, index) => {
    if (step.trim() && !step.includes('Captured screenshot')) {
      text += `${index + 1}. ${step.trim()}\n`;
    }
  });
  text += `\n`;
  
  // Expected Results
  text += `✅ Expected Results\n\n`;
  text += `[Please fill in the expected behavior here]\n\n`;
  
  // Actual Results
  text += `❌ Actual Results\n\n`;
  text += `URL: ${reportUrl}\n`;
  text += `Steps performed: ${stats.total} actions recorded\n`;
  text += `Details: See "Steps to Reproduce" section above for detailed actions\n\n`;
  text += `[Please describe what actually happened and any error messages or unexpected behavior]\n\n`;
  
  // Environment
  text += `🖥️ Environment\n\n`;
  text += `- URL: ${reportUrl}\n`;
  text += `- Browser: ${navigator.userAgent.split(' ')[0]}\n`;
  text += `- Platform: ${navigator.platform}\n`;
  text += `- Language: ${navigator.language}\n`;
  text += `- Screen Resolution: ${screen.width}x${screen.height}\n`;
  text += `- Viewport: ${window.innerWidth}x${window.innerHeight}\n`;
  text += `- Pixel Ratio: ${window.devicePixelRatio}\n`;
  text += `- Online Status: ${navigator.onLine ? 'Online' : 'Offline'}\n`;
  text += `- Cookies Enabled: ${navigator.cookieEnabled ? 'Yes' : 'No'}\n`;
  text += `- Time Zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`;
  
  return text;
}

/**
 * Generate steps with screenshot support
 * Only shows UI interactions, excludes console and performance events
 */
function generateStepsWithScreenshots(steps) {
  if (!steps || steps.length === 0) {
    return '<div style="text-align: center; color: #374151; padding: 20px;">No steps recorded</div>';
  }
  
  // Filter out console and performance events
  const uiSteps = steps.filter(step => 
    step.type !== 'console' && step.type !== 'performance'
  );
  
  if (uiSteps.length === 0) {
    return '<div style="text-align: center; color: #374151; padding: 20px;">No UI interaction steps recorded</div>';
  }
  
  let html = '';
  
  uiSteps.forEach((step, index) => {
    const stepNumber = index + 1;
    const timestamp = step.meta?.timestamp ? `+${Math.round(step.meta.timestamp / 1000)}s` : '';
    const action = step.meta?.action || step.type || 'action';
    
    // Determine step type and styling
    let stepClass = 'step-normal';
    let stepIcon = '👆';
    let stepColor = '#3b82f6';
    
    if (step.type === 'error-detected') {
      stepClass = 'step-error';
      stepIcon = '❌';
      stepColor = '#dc2626';
    } else if (step.type === 'screenshot') {
      stepClass = 'step-screenshot';
      stepIcon = '📸';
      stepColor = '#8b5cf6';
    } else if (step.type === 'console') {
      stepIcon = '📝';
      stepColor = '#f59e0b';
    } else if (step.type === 'form') {
      stepIcon = '📝';
      stepColor = '#10b981';
    }
    
    html += `
      <div style="margin-bottom: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: white;">
        <div style="padding: 12px; border-bottom: 1px solid #e5e7eb; background: #f8fafc;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 16px;">${stepIcon}</span>
            <strong style="color: ${stepColor};">Step ${stepNumber}: ${action.toUpperCase()}</strong>
            <span style="color: #374151; font-size: 12px; margin-left: auto;">${timestamp}</span>
          </div>
        </div>
        <div style="padding: 12px;">
    `;
    
    // Add step details
    if (step.url) {
      html += `<div style="margin-bottom: 8px; color: #374151;"><strong style="color: #1f2937;">URL:</strong> <code style="background: #f1f5f9; padding: 2px 4px; border-radius: 3px; font-size: 12px; color: #475569;">${step.url}</code></div>`;
    }
    
    if (step.selector && step.selector !== 'performance' && step.selector !== 'console') {
      html += `<div style="margin-bottom: 8px; color: #374151;"><strong style="color: #1f2937;">Element:</strong> <code style="background: #f1f5f9; padding: 2px 4px; border-radius: 3px; font-size: 12px; color: #475569;">${step.selector}</code></div>`;
    }
    
    if (step.text) {
      html += `<div style="margin-bottom: 8px; color: #374151;"><strong style="color: #1f2937;">Details:</strong> ${step.text}</div>`;
    }
    
    
    // Add screenshot if available
    if (step.screenshot) {
      html += `<div style="margin-top: 12px;">`;
      
      // Handle both old format (step.screenshot.dataURL) and new format (step.screenshot as base64)
      const screenshotData = typeof step.screenshot === 'string' ? step.screenshot : step.screenshot.dataURL;
      const screenshotDescription = typeof step.screenshot === 'object' ? (step.screenshot.description || 'Captured screenshot') : 'Manual screenshot';
      
      html += `<div style="margin-bottom: 8px; color: #374151;"><strong style="color: #1f2937;">📸 Screenshot:</strong> ${screenshotDescription}</div>`;
      
      if (screenshotData) {
        html += `
          <div style="border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; max-width: 100%; background: #f8fafc;">
            <img src="${screenshotData}" 
                 style="width: 100%; height: auto; max-height: 200px; object-fit: contain; cursor: pointer; display: block;" 
                 onclick="this.style.maxHeight = this.style.maxHeight === 'none' ? '200px' : 'none'; this.style.objectFit = this.style.objectFit === 'contain' ? 'cover' : 'contain';"
                 title="Click to expand/collapse and toggle fit mode">
          </div>
        `;
      } else if (step.screenshot.note) {
        html += `<div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 8px; border-radius: 4px; font-size: 12px; color: #92400e;">${step.screenshot.note}</div>`;
      }
      
      // Display metadata for manual screenshots
      if (step.metadata) {
        html += `<div style="font-size: 12px; color: #6b7280; margin-top: 4px; display: flex; gap: 16px; flex-wrap: wrap;">`;
        if (step.metadata.viewport) {
          html += `<span>📱 Viewport: ${step.metadata.viewport}</span>`;
        }
        if (step.metadata.scroll) {
          html += `<span>📜 Scroll: ${step.metadata.scroll}</span>`;
        }
        if (step.metadata.title) {
          html += `<span>📄 Page: ${step.metadata.title}</span>`;
        }
        html += `</div>`;
      } else if (step.screenshot.viewport) {
        html += `<div style="font-size: 12px; color: #6b7280; margin-top: 4px;">📱 Viewport: ${step.screenshot.viewport}</div>`;
      }
      
      html += `</div>`;
    }
    
    html += `
        </div>
      </div>
    `;
  });
  
  return html;
}

/**
 * Copy report to clipboard
 * Only includes UI interactions, excludes console and performance events
 */
async function copyReportToClipboard() {
  const readableSteps = convertStepsToReadable(allSteps);
  const stats = calculateStats(allSteps);
  
  // Generate title based on URL - use the current tracked URL
  let title = 'Bug Report';
  const currentUrl = await getCurrentUrl();
  if (currentUrl && currentUrl !== 'Unknown URL') {
    try {
      const domain = new URL(currentUrl).hostname;
      const path = new URL(currentUrl).pathname;
      title = `Issue on ${domain}`;
      if (path && path !== '/') {
        const pathParts = path.split('/').filter(p => p);
        if (pathParts.length > 0) {
          title += `/${pathParts[0]}`;
          if (pathParts.length > 1) {
            title += `/${pathParts[1]}`;
          }
        }
      }
    } catch (e) {
      // If URL parsing fails, use default title
    }
  }
  
  // Find screenshots in steps
  const screenshots = allSteps.filter(step => step.type === 'screenshot' && step.dataURL);
  
  // Create action summary for Actual Results
  const keyActions = allSteps.filter(step => 
    step.type !== 'console' && 
    step.type !== 'performance' && 
    !['screenshot', 'focus', 'blur'].includes(step.meta?.action || step.type)
  );
  
  const actionSummary = keyActions.map((step, index) => {
    const action = step.meta?.action || step.type || 'action';
    const target = step.text || step.selector || 'element';
    
    switch (action) {
      case 'click':
        return `Clicked on ${target}`;
      case 'input':
        return `Entered data in ${target}`;
      case 'select':
        return `Selected option from ${target}`;
      case 'submit':
        return `Submitted form`;
      case 'navigation':
        return `Navigated to ${target}`;
      case 'keypress':
        return `Pressed ${step.text || 'key'}`;
      case 'change':
        return `Changed ${target}`;
      case 'toggle':
        return `Toggled ${target}`;
      default:
        return `Performed ${action} on ${target}`;
    }
  }).join(' → ');
  
  let text = `${title}\n\n`;
  
  // Statistics at the top
  text += `📊 Statistics\n`;
  text += `Total UI Steps: ${stats.total}\n`;
  text += `Click Actions: ${stats.click || 0}\n`;
  text += `Form Interactions: ${stats.form}\n`;
  text += `Navigation Actions: ${stats.navigation || 0}\n`;
  if (stats.error > 0) text += `Errors: ${stats.error}\n`;
  if (stats.warning > 0) text += `Warnings: ${stats.warning}\n`;
  if (stats.success > 0) text += `Success Events: ${stats.success}\n`;
  text += `Generated: ${new Date().toLocaleString()}\n\n`;
  
  // Defect Screenshot section
  if (screenshots.length > 0) {
    text += `📸 Defect Screenshot\n`;
    screenshots.forEach((screenshot, index) => {
      const screenshotDesc = screenshot.description || `Screenshot ${index + 1}`;
      const filename = `screenshot${String(index + 1).padStart(2, '0')}.png`;
      text += `${screenshotDesc}: ./bug-report-assets/${filename}\n`;
    });
    text += `\n`;
  }
  
  // Steps to Reproduce
  text += `📝 Steps to Reproduce\n${readableSteps}\n\n`;
  
  // Expected Results
  text += `✅ Expected Results\n`;
  const expectedResults = document.getElementById('expected-results')?.value || '[Please fill in the expected behavior here]';
  text += `${expectedResults}\n\n`;
  
  // Actual Results
  text += `❌ Actual Results\n`;
  const reportUrl = currentUrl || 'Unknown URL';
  text += `URL: ${reportUrl}\n`;
  text += `Steps performed: ${stats.total} actions recorded\n`;
  text += `Details: See "Steps to Reproduce" section above for detailed actions\n\n`;
  const actualResults = document.getElementById('actual-results')?.value || '[Please describe what actually happened and any error messages or unexpected behavior]';
  text += `${actualResults}\n\n`;
  
  // Environment metadata
  text += `🖥️ Environment\n`;
  text += `URL: ${reportUrl}\n`;
  text += `Browser: ${navigator.userAgent.split(' ')[0]}\n`;
  text += `Platform: ${navigator.platform}\n`;
  text += `Language: ${navigator.language}\n`;
  text += `Screen Resolution: ${screen.width}x${screen.height}\n`;
  text += `Viewport: ${window.innerWidth}x${window.innerHeight}\n`;
  text += `Pixel Ratio: ${window.devicePixelRatio}\n`;
  text += `Online Status: ${navigator.onLine ? 'Online' : 'Offline'}\n`;
  text += `Cookies Enabled: ${navigator.cookieEnabled ? 'Yes' : 'No'}\n`;
  text += `Time Zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`;
  
  navigator.clipboard.writeText(text).then(() => {
    // Show success feedback
    const copyBtn = document.querySelector('#copy-report');
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✅ Copied!';
    copyBtn.style.background = '#10b981';
    setTimeout(() => {
      copyBtn.textContent = originalText;
      copyBtn.style.background = '#10b981';
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy to clipboard:', err);
  });
}

/**
 * Capture screenshot during pause
 */
async function captureScreenshot() {
  console.log('Screenshot button clicked!');
  
  if (!isExtensionActive) {
    console.log('Extension not active');
    status.textContent = 'Extension must be activated first';
    status.style.color = '#dc3545';
    return;
  }

  // Test background script first
  const testResponse = await testBackgroundScript();
  if (!testResponse) {
    console.error('Background script not responding');
    status.textContent = 'Background script not responding';
    status.style.color = '#dc3545';
    return;
  }
  
  console.log('Background script is responding, proceeding with screenshot...');

  try {
    console.log('Getting active tab...');
    // Send message to background script to capture screenshot
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('Active tab:', tab);
    
    console.log('Sending message to background script...');
    const response = await chrome.runtime.sendMessage({
      cmd: 'capture-screenshot-pause',
      timestamp: Date.now()
    });
    console.log('Background script response:', JSON.stringify(response, null, 2));

    if (response && response.success) {
      console.log('Screenshot captured successfully!');
      status.textContent = 'Screenshot captured successfully!';
      status.style.color = '#22c55e';
      
      // Refresh steps to show the new screenshot step
      setTimeout(() => {
        loadSteps(true);
      }, 500);
    } else {

      const errorMsg = response?.error || 'Unknown error';
      status.textContent = `Failed to capture screenshot: ${errorMsg}`;
      status.style.color = '#dc3545';
    }
  } catch (error) {

    status.textContent = 'Screenshot capture failed: ' + error.message;
    status.style.color = '#dc3545';
  }
}

/**
 * Advanced Screenshot Widget Functions
 */
function toggleScreenshotPanel() {
  if (!screenshotPanel) return;
  
  const isActive = screenshotPanel.classList.contains('active');
  if (isActive) {
    screenshotPanel.classList.remove('active');
  } else {
    screenshotPanel.classList.add('active');
    loadScreenshotGallery();
  }
}

function closeScreenshotPanelHandler() {
  if (screenshotPanel) {
    screenshotPanel.classList.remove('active');
  }
}

// Add keyboard support for closing screenshot panel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && screenshotPanel && screenshotPanel.classList.contains('active')) {
    screenshotPanel.classList.remove('active');
  }
});



async function captureScreenshotAdvanced(type = 'fullpage') {
  console.log(`Capturing ${type} screenshot...`);
  
  if (!isExtensionActive) {
    console.log('Extension not active');
    status.textContent = 'Extension must be activated first';
    status.style.color = '#dc3545';
    return;
  }

  // Test background script first
  const testResponse = await testBackgroundScript();
  if (!testResponse) {
    console.error('Background script not responding');
    status.textContent = 'Background script not responding';
    status.style.color = '#dc3545';
    return;
  }
  
  console.log('Background script is responding, proceeding with screenshot...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Use the same background script method for all screenshot types
    const response = await chrome.runtime.sendMessage({
      cmd: 'capture-screenshot-pause',
      type: type,
      timestamp: Date.now()
    });

    console.log('Full response from background:', JSON.stringify(response, null, 2));
    
    if (response && response.success) {
      // Handle both old and new response formats
      const screenshotData = response.screenshot || response;
      const dataURL = screenshotData.dataURL || screenshotData.screenshot;
      
      if (dataURL) {
        const screenshot = {
          id: Date.now(),
          dataURL: dataURL,
          type: type,
          timestamp: screenshotData.timestamp || Date.now(),
          url: screenshotData.url || window.location.href,
          viewport: screenshotData.viewport || `${window.innerWidth}x${window.innerHeight}`
        };
        
        screenshots.unshift(screenshot); // Add to beginning
        
        // Limit to 20 screenshots
        if (screenshots.length > 20) {
          screenshots = screenshots.slice(0, 20);
        }
        
        // Save to storage
        await saveScreenshots();
        
        // Update gallery
        loadScreenshotGallery();
        
        status.textContent = `${type} screenshot captured successfully!`;
        status.style.color = '#22c55e';
        
        // Refresh steps to show the new screenshot step
        setTimeout(() => {
          loadSteps(true);
        }, 500);
      } else {
        console.error('No screenshot data in response:', response);
        status.textContent = 'Failed to capture screenshot - no data';
        status.style.color = '#dc3545';
      }
    } else {
      console.error('Screenshot capture failed:', response);
      const errorMsg = response?.error || 'Unknown error';
      status.textContent = `Failed to capture screenshot: ${errorMsg}`;
      status.style.color = '#dc3545';
    }
  } catch (error) {
    console.error('Screenshot capture error:', error);
    status.textContent = 'Screenshot capture failed: ' + error.message;
    status.style.color = '#dc3545';
  }
}

/**
 * Start custom area selection on the website
 */
async function startCustomSelection() {
  if (!isExtensionActive) {
    status.textContent = 'Extension must be activated first';
    status.className = 'status error';
    return;
  }

  // Close the screenshot panel first
  if (screenshotPanel) {
    screenshotPanel.classList.remove('active');
  }

  try {
    // Get current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      // Send message to content script to start area selection
      const response = await chrome.tabs.sendMessage(tab.id, { 
        type: 'start-custom-area-selection' 
      });
      
      if (response && response.ok) {
        status.textContent = 'Area selection started on website - close this popup and drag to select';
        status.style.color = '#3b82f6';
        
        // Close the popup after a short delay to let user see the message
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        status.textContent = 'Failed to start area selection';
        status.style.color = '#dc3545';
      }
    } else {
      status.textContent = 'No active tab found';
      status.className = 'status error';
    }
  } catch (error) {
    console.error('Error starting custom area selection:', error);
    status.textContent = 'Error starting area selection: ' + error.message;
    status.style.color = '#dc3545';
  }
}

// Custom area selection functions moved to content script

function loadScreenshotGallery() {
  if (!galleryGrid) return;
  
  if (screenshots.length === 0) {
    galleryGrid.innerHTML = '<div class="no-screenshots">No screenshots yet</div>';
    return;
  }
  
  // Deduplicate screenshots first, then filter out invalid ones
  const uniqueScreenshots = deduplicateScreenshots(screenshots);
  const validScreenshots = uniqueScreenshots.filter((screenshot, index) => {
    if (!screenshot || !screenshot.dataURL) {
      console.warn('Invalid screenshot data at index:', index);
      return false;
    }
    return true;
  });
  
  if (validScreenshots.length === 0) {
    galleryGrid.innerHTML = '<div class="no-screenshots">No valid screenshots available</div>';
    return;
  }
  
  galleryGrid.innerHTML = validScreenshots.map((screenshot, index) => {
    // Skip invalid screenshots in rendering
    if (!screenshot || !screenshot.dataURL) {
      return '';
    }
    
    // Determine screenshot type and styling
    const screenshotType = screenshot.type || 'standard';
    const isCustom = screenshotType === 'custom';
    const isNavigation = screenshotType === 'navigation';
    
    // Get screenshot dimensions for display
    const dimensions = screenshot.area ? 
      `${screenshot.area.width}x${screenshot.area.height}` : 
      (screenshot.viewport || 'Unknown');
    
    // Create type-specific styling and labels
    let typeLabel = '';
    let typeClass = '';
    
    if (isCustom) {
      typeLabel = 'Custom Area';
      typeClass = 'custom-screenshot';
    } else if (isNavigation) {
      typeLabel = 'Navigation';
      typeClass = 'navigation-screenshot';
    } else {
      typeLabel = 'Full Page';
      typeClass = 'fullpage-screenshot';
    }
    
    return `
      <div class="screenshot-thumbnail ${typeClass}" data-index="${index}" onclick="viewScreenshot(${index})" title="Click to view full size - ${typeLabel} (${dimensions})">
        <img src="${screenshot.dataURL}" alt="Screenshot ${index + 1} - ${typeLabel}" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
        <div class="screenshot-error" style="display: none; padding: 10px; text-align: center; color: #666; font-size: 12px;">
          Failed to load image
        </div>
        <div class="thumbnail-overlay">
          <div class="thumbnail-info">
            <span class="screenshot-type">${typeLabel}</span>
            <span class="screenshot-dimensions">${dimensions}</span>
          </div>
          <div class="thumbnail-actions">
            <button class="thumbnail-btn" onclick="event.stopPropagation(); viewScreenshot(${index})" title="View">👁️</button>
            <button class="thumbnail-btn" onclick="event.stopPropagation(); downloadScreenshotByIndex(${index})" title="Download">📥</button>
            <button class="thumbnail-btn" onclick="event.stopPropagation(); deleteScreenshotByIndex(${index})" title="Delete">🗑️</button>
          </div>
        </div>
      </div>
    `;
  }).filter(html => html !== '').join('');
}

function viewScreenshot(index) {
  if (index < 0 || index >= screenshots.length) return;
  
  currentScreenshotIndex = index;
  const screenshot = screenshots[index];
  
  // Validate screenshot object and its properties
  if (!screenshot || !screenshot.dataURL) {
    console.error('Invalid screenshot data at index:', index);
    return;
  }
  
  if (modalImage && screenshotModal) {
    modalImage.src = screenshot.dataURL;
    modalImage.alt = `Screenshot ${index + 1} - ${screenshot.type || 'Standard'} capture`;
    screenshotModal.classList.add('active');
    
    // Update navigation arrows
    updateNavigationArrows();
    
    // Add keyboard navigation
    document.addEventListener('keydown', handleModalKeydown);
  }
}

function updateNavigationArrows() {
  if (modalPrev && modalNext) {
    modalPrev.disabled = currentScreenshotIndex <= 0;
    modalNext.disabled = currentScreenshotIndex >= screenshots.length - 1;
  }
}

function handleModalKeydown(e) {
  if (!screenshotModal.classList.contains('active')) return;
  
  switch(e.key) {
    case 'Escape':
      closeScreenshotModal();
      break;
    case 'ArrowLeft':
      if (currentScreenshotIndex > 0) {
        viewScreenshot(currentScreenshotIndex - 1);
      }
      break;
    case 'ArrowRight':
      if (currentScreenshotIndex < screenshots.length - 1) {
        viewScreenshot(currentScreenshotIndex + 1);
      }
      break;
  }
}

function closeScreenshotModal() {
  if (screenshotModal) {
    screenshotModal.classList.remove('active');
  }
  currentScreenshotIndex = -1;
  
  // Remove keyboard navigation listener
  document.removeEventListener('keydown', handleModalKeydown);
}

function downloadCurrentScreenshot() {
  if (currentScreenshotIndex >= 0 && currentScreenshotIndex < screenshots.length) {
    downloadScreenshotByIndex(currentScreenshotIndex);
  }
}

function downloadScreenshotByIndex(index) {
  if (index < 0 || index >= screenshots.length) return;
  
  const screenshot = screenshots[index];
  
  // Validate screenshot object and its properties
  if (!screenshot || !screenshot.dataURL || !screenshot.timestamp) {
    console.error('Invalid screenshot data for download at index:', index);
    return;
  }
  
  const link = document.createElement('a');
  link.download = `screenshot-${screenshot.timestamp}.png`;
  link.href = screenshot.dataURL;
  link.click();
}

async function copyCurrentScreenshot() {
  if (currentScreenshotIndex >= 0 && currentScreenshotIndex < screenshots.length) {
    const screenshot = screenshots[currentScreenshotIndex];
    
    // Validate screenshot object and its properties
    if (!screenshot || !screenshot.dataURL) {
      console.error('Invalid screenshot data for copy at index:', currentScreenshotIndex);
      status.textContent = 'Invalid screenshot data';
      status.style.color = '#dc3545';
      return;
    }
    
    try {
      // Convert data URL to blob
      const response = await fetch(screenshot.dataURL);
      const blob = await response.blob();
      
      // Copy to clipboard
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      
      status.textContent = 'Screenshot copied to clipboard!';
      status.style.color = '#22c55e';
    } catch (error) {
      console.error('Failed to copy screenshot:', error);
      status.textContent = 'Failed to copy screenshot';
      status.style.color = '#dc3545';
    }
  }
}

function deleteCurrentScreenshot() {
  if (currentScreenshotIndex >= 0 && currentScreenshotIndex < screenshots.length) {
    deleteScreenshotByIndex(currentScreenshotIndex);
    closeScreenshotModal();
  }
}

function deleteScreenshotByIndex(index) {
  if (index < 0 || index >= screenshots.length) return;
  
  screenshots.splice(index, 1);
  saveScreenshots();
  loadScreenshotGallery();
  
  status.textContent = 'Screenshot deleted';
  status.style.color = '#f59e0b';
}

function clearAllScreenshots(skipConfirmation = false) {
  if (screenshots.length === 0) return;
  
  if (!skipConfirmation && !confirm('Are you sure you want to delete all screenshots?')) {
    return;
  }
  
  screenshots = [];
  saveScreenshots();
  loadScreenshotGallery();
  
  // Reset report download tracker
  reportDownloadTracker.reset();
  
  if (!skipConfirmation) {
    status.textContent = 'All screenshots cleared';
    status.style.color = '#f59e0b';
  }
}

async function saveScreenshots() {
  try {
    await chrome.storage.local.set({ screenshots: screenshots });
  } catch (error) {
    console.error('Failed to save screenshots:', error);
  }
}

async function loadScreenshots() {
  try {
    const result = await chrome.storage.local.get(['screenshots']);
    const loadedScreenshots = result.screenshots || [];
    // Deduplicate screenshots when loading from storage
    screenshots = deduplicateScreenshots(loadedScreenshots);
    console.log('Loaded screenshots from storage:', loadedScreenshots.length, 'screenshots');
    console.log('After deduplication:', screenshots.length, 'unique screenshots');
    console.log('Screenshots data:', screenshots);
    
    // Save back deduplicated screenshots if any duplicates were removed
    if (screenshots.length !== loadedScreenshots.length) {
      await saveScreenshots();
    }
  } catch (error) {
    console.error('Failed to load screenshots:', error);
    screenshots = [];
  }
}


/**
 * Stop recording on all tabs
 */
async function stopRecording() {
  try {
    // Get all tabs and send stop message
    const tabs = await chrome.tabs.query({});
    
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { __bugCapturerStop: true });
      } catch (e) {
        // Ignore errors for tabs that don't have content script
      }
    }
    
    // Tell background we are no longer recording
    try {
      await chrome.runtime.sendMessage({
        cmd: 'update-recording-state',
        isRecording: false
      });
    } catch (e) {
      // Non-fatal
      console.warn('Failed to persist stopRecording state:', e);
    }
    
    // Load latest steps and show preview instead of auto-downloading
    await loadSteps();
    
    // Show preview of bug report instead of downloading
    if (allSteps.length > 0) {
      generateComprehensiveReport();
      status.textContent = 'Recording stopped - Preview generated. Click "Download Report" to save with images.';
      status.style.color = '#28a745';
    } else {
      status.textContent = 'Recording stopped - No steps to report';
    }
    
    updateToggleButton(false);
  } catch (error) {
    status.textContent = 'Error stopping recording: ' + error.message;
  }
}

/**
 * Toggle recording on current tab
 */
async function toggleRecording() {
  if (!isExtensionActive) {
    status.textContent = 'Extension must be activated first';
    status.className = 'status error';
    return;
  }
  
  try {
    toggleBtn.disabled = true;
    
    // Get current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      const response = await chrome.tabs.sendMessage(tab.id, { __bugCapturerToggle: true });
      
      if (response && response.ok) {
        updateToggleButton(response.recording);
        
        if (response.recording) {
          status.textContent = 'Recording resumed - Session continues';
          status.style.color = '#28a745';
        } else {
          status.textContent = 'Recording paused - Report generated';
          status.style.color = '#ffc107';
          
          // Refresh steps to show the pause report
          setTimeout(() => {
            loadSteps();
          }, 1000);
        }
      } else {
        status.textContent = 'Failed to toggle recording';
        status.style.color = '#dc3545';
      }
    } else {
      status.textContent = 'No active tab found';
      status.className = 'status error';
    }
  } catch (error) {
    status.textContent = 'Error toggling recording: ' + error.message;
    status.style.color = '#dc3545';
  } finally {
    toggleBtn.disabled = false;
  }
}

/**
 * Update toggle button appearance based on recording state
 */
function updateToggleButton(isRecording) {
  if (!toggleBtn) return;
  
  if (isRecording) {
    toggleBtn.textContent = '⏸️ Pause Recording';
    toggleBtn.className = 'control-btn pause-btn';
  } else {
    toggleBtn.textContent = '▶️ Resume Recording';
    toggleBtn.className = 'control-btn resume-btn';
  }
  
  // Show screenshot widget when recording is active or paused
  if (screenshotWidget && screenshotTriggerBtn) {
    if (isRecording) {
      // Recording is active, show screenshot widget alongside pause button
      screenshotWidget.style.display = 'inline-block';
      screenshotTriggerBtn.disabled = false;
      screenshotTriggerBtn.classList.remove('disabled');
    } else {
      // Recording is paused, keep screenshot widget visible
      screenshotWidget.style.display = 'inline-block';
      screenshotTriggerBtn.disabled = false;
      screenshotTriggerBtn.classList.remove('disabled');
    }
  }
}

/**
 * Check current recording state
 */
async function checkRecordingState() {
  if (!isExtensionActive) {
    status.textContent = 'Extension Inactive - Click Activate to Start';
    status.style.color = '#6c757d';
    return;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab) {
      // First check background state for consistency
      const backgroundState = await chrome.runtime.sendMessage({ cmd: 'get-persistent-state' });
      
      // Add timeout to prevent hanging
      const response = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { __bugCapturerGetState: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
      ]);
      
      if (response && response.ok) {
        // Verify state consistency between content script and background
        const contentRecording = response.recording;
        const backgroundRecording = backgroundState?.state?.isRecording || false;
        
        // Use content script state as primary, but log inconsistencies
        if (contentRecording !== backgroundRecording) {
          console.warn('State inconsistency detected:', {
            content: contentRecording,
            background: backgroundRecording
          });
          // Sync background state with content script
          await chrome.runtime.sendMessage({
            cmd: 'update-recording-state',
            isRecording: contentRecording
          });
        }
        
        updateToggleButton(contentRecording);
        
        if (contentRecording) {
        status.textContent = 'Recording active';
        status.className = 'status success';
        } else {
          status.textContent = 'Recording paused';
          status.className = 'status warning';
        }
      } else {
        // Content script responded but not ready - use background state as fallback
        const fallbackRecording = backgroundState?.state?.isRecording || false;
        status.textContent = 'Content script initializing...';
        status.className = 'status warning';
        updateToggleButton(fallbackRecording);
      }
    } else {
      status.textContent = 'No active tab found';
      status.className = 'status error';
    }
  } catch (error) {
    // Content script might not be loaded yet or timeout occurred
    console.log('Content script not ready:', error.message);
    
    // Use background state as fallback during errors
    try {
      const backgroundState = await chrome.runtime.sendMessage({ cmd: 'get-persistent-state' });
      const fallbackRecording = backgroundState?.state?.isRecording || false;
      
      status.textContent = 'Content script loading...';
      status.style.color = '#ffc107';
      updateToggleButton(fallbackRecording);
      
      // Retry with exponential backoff for timeouts
      if (error.message === 'Timeout') {
        setTimeout(() => checkRecordingState(), 3000);
      }
    } catch (bgError) {
      console.error('Failed to get background state:', bgError);
      status.textContent = 'Extension error - please refresh';
      status.style.color = '#dc3545';
    }
  }
}

/**
 * Start automatic refresh when extension is active
 */
function startAutoRefresh() {
  // Always clear existing interval first
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
  
  // Only start if extension is active
  if (!isExtensionActive) {
    return;
  }
  
  // Check for new steps every 3 seconds (increased from 2 to reduce load)
  autoRefreshInterval = setInterval(async () => {
    if (isExtensionActive) {
      try {
        await loadSteps(true); // Silent refresh
        // Also refresh screenshots to catch any new ones
        await loadScreenshots();
        loadScreenshotGallery();
      } catch (error) {
        console.warn('Auto-refresh error:', error);
        // Stop auto-refresh on persistent errors
        stopAutoRefresh();
      }
    } else {
      // Stop if extension becomes inactive
      stopAutoRefresh();
    }
  }, 3000);
}

/**
 * Stop automatic refresh
 */
function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

/**
 * Activate the extension and initialize all components
 */
async function activateExtension() {
  try {
    isExtensionActive = true;
    
    // Update UI state
    activateBtn.textContent = '🛑 Deactivate Extension';
    activateBtn.className = 'deactivation-btn';
    
    // Enable all buttons
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('disabled');
    clearBtn.disabled = false;
    clearBtn.classList.remove('disabled');
    exportBtn.disabled = false;
    exportBtn.classList.remove('disabled');
    if (exportWordBtn) {
      exportWordBtn.disabled = false;
      exportWordBtn.classList.remove('disabled');
    }
    if (tvdBtn) {
      tvdBtn.disabled = false;
      tvdBtn.classList.remove('disabled');
    }
    toggleBtn.disabled = false;
    toggleBtn.classList.remove('disabled');
    stopBtn.disabled = false;
    stopBtn.classList.remove('disabled');
    
    // Enable and show screenshot widget
    if (screenshotWidget && screenshotTriggerBtn) {
      screenshotTriggerBtn.disabled = false;
      screenshotTriggerBtn.classList.remove('disabled');
      screenshotWidget.style.display = 'inline-block';
    }
    
    // Initialize content script components
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Try to send message to content script, inject if needed
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'activate-extension' });
    } catch (error) {

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js']
        });
        // Wait a moment for injection to complete
        await new Promise(resolve => setTimeout(resolve, 100));
        await chrome.tabs.sendMessage(tab.id, { type: 'activate-extension' });
      } catch (injectionError) {
        console.warn('Failed to inject content script:', injectionError);
        // Continue without content script for now
      }
    }
    
    // Initialize persistent recording state
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const startTime = Date.now();
    
    // Update background script with session info
    await chrome.runtime.sendMessage({
      cmd: 'update-recording-state',
      isRecording: true,
      sessionId: sessionId,
      startTime: startTime
    });
    
    // Load initial data
    await loadSteps();
    
    // Start automatic refresh
    startAutoRefresh();
    
    await checkRecordingState();
    
    status.textContent = 'Extension Activated - Recording Started';
    status.style.color = '#28a745';
    
  } catch (error) {
    console.error('Error activating extension:', error);
    status.textContent = 'Error activating extension';
    status.style.color = '#dc3545';
  }
}

/**
 * Deactivate the extension and disable all components
 */
async function deactivateExtension() {
  try {
    // Stop automatic refresh
    stopAutoRefresh();
    
    isExtensionActive = false;
    
    // Update UI state
    activateBtn.textContent = '🚀 Activate Extension';
    activateBtn.className = 'activation-btn';
    
    // Disable all buttons
    refreshBtn.disabled = true;
    refreshBtn.classList.add('disabled');
    clearBtn.disabled = true;
    clearBtn.classList.add('disabled');
    exportBtn.disabled = true;
    exportBtn.classList.add('disabled');
    if (tvdBtn) {
      tvdBtn.disabled = true;
      tvdBtn.classList.add('disabled');
    }
    toggleBtn.disabled = true;
    toggleBtn.classList.add('disabled');
    stopBtn.disabled = true;
    stopBtn.classList.add('disabled');
    
    // Disable and hide screenshot widget when extension is deactivated
    if (screenshotWidget && screenshotTriggerBtn) {
      screenshotTriggerBtn.disabled = true;
      screenshotTriggerBtn.classList.add('disabled');
      screenshotWidget.style.display = 'none';
      // Also close the panel if it's open
      if (screenshotPanel) {
        screenshotPanel.classList.remove('active');
      }
    }
    
    // Stop recording if active
    await stopRecording();
    
    // Persist deactivated state explicitly
    try {
      await chrome.runtime.sendMessage({
        cmd: 'update-recording-state',
        isRecording: false,
        sessionId: null,
        startTime: null
      });

    } catch (e) {

    }
    
    // Generate and show final report before deactivation
    status.textContent = 'Generating final report...';
    status.style.color = '#ffc107';
    
    try {
      // Load final steps before generating report
      await loadSteps();
      
      // Generate comprehensive report
      if (allSteps.length > 0) {
        await generateComprehensiveReport();
        status.textContent = 'Report generated - Extension deactivated';
        status.style.color = '#28a745';
      } else {
        status.textContent = 'No steps recorded - Extension deactivated';
        status.style.color = '#6c757d';
      }
    } catch (reportError) {
      console.error('Error generating final report:', reportError);
      status.textContent = 'Extension deactivated (report generation failed)';
      status.style.color = '#dc3545';
    }
    
    // Deactivate content script components
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Try to send deactivation message, ignore if content script not available
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'deactivate-extension' });
    } catch (error) {
      console.log('Content script not available for deactivation message:', error);
      // This is expected if content script was never loaded or tab was closed
    }
    
    // Clear steps display after a delay to show the report
    setTimeout(() => {
      stepsContainer.innerHTML = '<div class="no-steps">Extension deactivated. Click Activate to start recording.</div>';
      allSteps = [];
      lastStepCount = 0;
    }, 2000);
    
  } catch (error) {
    console.error('Error deactivating extension:', error);
    status.textContent = 'Error deactivating extension';
    status.style.color = '#dc3545';
  }
}

/**
 * Toggle extension activation state
 */
async function toggleExtensionActivation() {
  if (isExtensionActive) {
    await deactivateExtension();
  } else {
    await activateExtension();
  }
}

// Event listeners
activateBtn.addEventListener('click', toggleExtensionActivation);
refreshBtn.addEventListener('click', loadSteps);
clearBtn.addEventListener('click', clearSteps);
exportBtn.addEventListener('click', async () => {
  await generateComprehensiveReport();
});

// Add Word document export functionality
const exportWordBtn = document.getElementById('export-word-btn');
if (exportWordBtn) {
  exportWordBtn.addEventListener('click', async () => {
    await generateWordDocumentReport();
  });
}

// Add TVD button functionality
if (tvdBtn) {
  tvdBtn.addEventListener('click', async () => {
    await generateTVDReport();
  });
}

// Test validator button event listener

stopBtn.addEventListener('click', stopRecording);
if (toggleBtn) {
  toggleBtn.addEventListener('click', toggleRecording);
}
// Advanced Screenshot Widget Event Listeners
if (screenshotTriggerBtn) {
  screenshotTriggerBtn.addEventListener('click', toggleScreenshotPanel);
}

if (closeScreenshotPanel) {
  closeScreenshotPanel.addEventListener('click', closeScreenshotPanelHandler);
}

if (captureCustomBtn) {
  captureCustomBtn.addEventListener('click', startCustomSelection);
}

// Full screenshot functionality moved to Enter key

if (clearScreenshots) {
  clearScreenshots.addEventListener('click', clearAllScreenshots);
}

if (modalClose) {
  modalClose.addEventListener('click', closeScreenshotModal);
}

if (modalPrev) {
  modalPrev.addEventListener('click', () => {
    if (currentScreenshotIndex > 0) {
      viewScreenshot(currentScreenshotIndex - 1);
    }
  });
}

if (modalNext) {
  modalNext.addEventListener('click', () => {
    if (currentScreenshotIndex < screenshots.length - 1) {
      viewScreenshot(currentScreenshotIndex + 1);
    }
  });
}

if (downloadScreenshot) {
  downloadScreenshot.addEventListener('click', downloadCurrentScreenshot);
}

if (copyScreenshot) {
  copyScreenshot.addEventListener('click', copyCurrentScreenshot);
}

if (deleteScreenshot) {
  deleteScreenshot.addEventListener('click', deleteCurrentScreenshot);
}

if (toggleStepsBtn) {
  toggleStepsBtn.addEventListener('click', toggleStepsContainer);
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  if (screenshotPanel && screenshotPanel.classList.contains('active')) {
    if (!screenshotPanel.contains(e.target) && !screenshotWidget.contains(e.target)) {
      screenshotPanel.classList.remove('active');
    }
  }
});

// Close modal when clicking outside
if (screenshotModal) {
  screenshotModal.addEventListener('click', (e) => {
    if (e.target === screenshotModal) {
      closeScreenshotModal();
    }
  });
}

searchBox.addEventListener('input', (e) => {
  renderSteps(allSteps, e.target.value);
});

// Global Enter key listener for full screenshot
document.addEventListener('keydown', (e) => {
  // Only trigger if Enter is pressed and extension is active
  if (e.key === 'Enter' && isExtensionActive) {
    // Don't trigger if user is typing in search box
    if (e.target === searchBox) {
      return;
    }
    
    // Don't trigger if user is typing in modal textareas
    if (e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    // Close popup and trigger screenshot from content script
    e.preventDefault();
    
    // Show status message
    status.textContent = 'Closing popup to capture screenshot on webpage...';
    status.style.color = '#3b82f6';
    
    // Close the popup after a short delay to let user see the message
    setTimeout(() => {
      window.close();
    }, 1000);
  }
});


/**
 * Show loading skeleton animation
 */
function showLoadingSkeleton() {
  const skeletonHtml = `
    <div class="loading-skeleton skeleton-step"></div>
    <div class="loading-skeleton skeleton-step"></div>
    <div class="loading-skeleton skeleton-step"></div>
    <div class="loading-skeleton skeleton-step"></div>
    <div class="loading-skeleton skeleton-step"></div>
  `;
  
  stepsContainer.innerHTML = skeletonHtml;
}

/**
 * Handle keyboard navigation for filter pills
 */
function handleFilterKeydown(event, filterType) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    // Filter functionality can be implemented here if needed
    console.log('Filter keydown:', filterType);
  }
}

/**
 * Handle keyboard navigation for step items
 */
function handleStepKeydown(event, stepElement) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleStepExpansion(stepElement);
  }
}

/**
 * Toggle steps container visibility
 */
function toggleStepsContainer() {
  if (!stepsContainer || !toggleStepsBtn) return;
  
  stepsCollapsed = !stepsCollapsed;
  
  if (stepsCollapsed) {
    stepsContainer.classList.add('collapsed');
    toggleStepsBtn.textContent = '▶';
    toggleStepsBtn.title = 'Show steps';
  } else {
    stepsContainer.classList.remove('collapsed');
    toggleStepsBtn.textContent = '▼';
    toggleStepsBtn.title = 'Hide steps';
  }
}

/**
 * Toggle step expansion
 */
function toggleStepExpansion(stepElement) {
  const isExpanded = stepElement.classList.contains('expanded');
  const icon = stepElement.querySelector('.step-expand-icon');
  
  if (isExpanded) {
    stepElement.classList.remove('expanded');
    stepElement.setAttribute('aria-expanded', 'false');
    icon.textContent = '▼';
  } else {
    stepElement.classList.add('expanded');
    stepElement.setAttribute('aria-expanded', 'true');
    icon.textContent = '▲';
  }
}

// Custom screenshots are now handled through background script storage

// Cleanup function to prevent memory leaks
function cleanup() {
  stopAutoRefresh();
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

// Cleanup when popup is closed
window.addEventListener('beforeunload', cleanup);
window.addEventListener('unload', cleanup);

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  // Load screenshots on popup open
  await loadScreenshots();
  
  // Load screenshot gallery
  loadScreenshotGallery();
  
  // Also refresh steps to catch any new screenshots
  await loadSteps(true);
  
  
  // Check if extension was previously activated and recording
  try {
    const response = await chrome.runtime.sendMessage({ cmd: 'get-persistent-state' });
    console.log('State restoration response:', response);
    
    if (response && response.ok && response.state) {
      const persistentState = response.state;
      
      // Check if extension was previously activated (either recording or has session data)
      const wasActive = persistentState.isRecording === true || persistentState.sessionId !== null;
      console.log('Extension was active:', wasActive, 'State:', persistentState);
      
      if (wasActive) {
        // Extension was active, restore state
        isExtensionActive = true;
        
        // Update UI to show activated state
        activateBtn.textContent = '🛑 Deactivate Extension';
        activateBtn.className = 'deactivation-btn';
        
        // Enable all buttons
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('disabled');
        clearBtn.disabled = false;
        clearBtn.classList.remove('disabled');
        exportBtn.disabled = false;
        exportBtn.classList.remove('disabled');
        if (exportWordBtn) {
          exportWordBtn.disabled = false;
          exportWordBtn.classList.remove('disabled');
        }
        if (tvdBtn) {
          tvdBtn.disabled = false;
          tvdBtn.classList.remove('disabled');
        }
        toggleBtn.disabled = false;
        toggleBtn.classList.remove('disabled');
        stopBtn.disabled = false;
        stopBtn.classList.remove('disabled');
        
        // Enable and show screenshot widget
        if (screenshotWidget && screenshotTriggerBtn) {
          screenshotTriggerBtn.disabled = false;
          screenshotTriggerBtn.classList.remove('disabled');
          screenshotWidget.style.display = 'inline-block';
        }
        
        // Set initial status based on recording state
        if (persistentState.isRecording === true) {
          status.textContent = 'Extension Active - Recording in Progress';
          status.style.color = '#28a745';
        } else {
          status.textContent = 'Extension Active - Recording Paused';
          status.style.color = '#ffc107';
        }
        
        // Load steps first, then check state with progressive delays
        await loadSteps();
        
        // Use progressive retry strategy for state checking
        let retryCount = 0;
        const maxRetries = 3;
        const checkStateWithRetry = async () => {
          try {
            await checkRecordingState();
            // Start auto-refresh for active extension
            startAutoRefresh();
          } catch (error) {
            retryCount++;
            if (retryCount < maxRetries) {
              console.log(`State check retry ${retryCount}/${maxRetries}`);
              setTimeout(checkStateWithRetry, 500 * retryCount); // Progressive delay
            } else {
              console.warn('Failed to check recording state after retries');
              // Fallback to background state
              updateToggleButton(persistentState.isRecording === true);
              startAutoRefresh();
            }
          }
        };
        
        // Initial delay to allow content script initialization
        setTimeout(checkStateWithRetry, 200);
      } else {
        // Extension is not active, show activation screen
        status.textContent = 'Extension Inactive - Click Activate to Start';
        status.style.color = '#6c757d';
        await loadSteps();
      }
    } else {
      // No valid state response
      status.textContent = 'Extension Inactive - Click Activate to Start';
      status.style.color = '#6c757d';
      await loadSteps();
    }
  } catch (error) {
    status.textContent = 'Extension Inactive - Click Activate to Start';
    status.style.color = '#6c757d';
    await loadSteps();
  }
});

// Make functions global for onclick handlers
window.viewScreenshot = viewScreenshot;
window.downloadScreenshotByIndex = downloadScreenshotByIndex;
window.deleteScreenshotByIndex = deleteScreenshotByIndex;
window.toggleStepExpansion = toggleStepExpansion;
window.handleFilterKeydown = handleFilterKeydown;
window.handleStepKeydown = handleStepKeydown;

// Keydown handler for special keys
document.addEventListener('keydown', function(e) {
  if (e.target.closest('[data-bc-ignore]')) return;
  
  // Record Enter key presses in form elements
  if (e.key === 'Enter' && ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) {
    recordStep('keypress', e.target, 'Pressed Enter').catch(() => {});
  }
  // Record Escape key presses
  else if (e.key === 'Escape') {
    recordStep('keypress', e.target, 'Pressed Escape').catch(() => {});
  }
  // Tab navigation removed - this was causing random navigation steps
  // Tab key should only be used for form navigation, not recorded as page navigation
  // Enter key screenshot handling removed - now handled by content script
  // to avoid duplicate screenshots
}, true);