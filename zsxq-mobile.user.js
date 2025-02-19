// ==UserScript==
// @name         简单修改知识星球样式以适配移动端
// @namespace    https://axutongxue.com/
// @version      0.2
// @description  知识星球网页版移动端适配
// @author       阿虚同学
// @match        https://wx.zsxq.com/*
// @license      MIT
// @grant        none
// ==/UserScript==
 
(function() {
    'use strict';
 
    const mainContentContainer = document.querySelector('.main-content-container');
    if (mainContentContainer) {
      mainContentContainer.style.setProperty('margin-left', '5%', 'important');
      mainContentContainer.style.setProperty('margin-right', '5%', 'important');
      mainContentContainer.style.setProperty('width', '100%', 'important');
      mainContentContainer.style.setProperty('max-width', '428px', 'important');
    }
 
    const groupPreviewContainer = document.querySelector('.group-preview-container');
    if (groupPreviewContainer) {
      groupPreviewContainer.style.setProperty('margin-left', '85%', 'important');
    }
 
    const searchcontainer = document.querySelector('.search-container');
    if (searchcontainer) {
      searchcontainer.style.setProperty('margin-left', '5%', 'important');
      searchcontainer.style.setProperty('margin-right', '5%', 'important');
      searchcontainer.style.setProperty('width', '300px', 'important');
    }
 
 
    const targetClasses = ['group-preview-wrapper', 'group-list-container','logo-container','redirect','user-container'];
 
    const observer = new MutationObserver(() => {
        hideTargetElements();
    });
 
    observer.observe(document, {
        childList: true,
        subtree: true
    });
 
    // 初始执行+周期性检查（应对懒加载）
    hideTargetElements();
    setInterval(hideTargetElements, 1000);
 
    function hideTargetElements() {
        targetClasses.forEach(className => {
            document.querySelectorAll(`.${className}`).forEach(element => {
                element.style.display = 'none';
            });
        });
    }
})();
