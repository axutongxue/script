// ==UserScript==
// @name         飞书页面高度调整器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在飞书页面右上角添加浮窗按钮，点击后调整页面高度并显示成功提示
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larkoffice.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 创建浮窗按钮
    const floatButton = document.createElement('div');
    floatButton.innerHTML = '??';

    // 设置按钮样式
    floatButton.style.cssText = `
        position: fixed;
        top: 70px;
        right: 60px;
        width: 50px;
        height: 50px;
        background-color: #4285f4;
        color: white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 20px;
        z-index: 9999;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        transition: all 0.3s ease;
        user-select: none;
    `;

    // 创建成功提示弹窗
    function showSuccessToast() {
        const toast = document.createElement('div');
        toast.innerHTML = '? 调整页面高度成功';

        toast.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background-color: #34a853;
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            opacity: 0;
            transform: translateX(100%);
            transition: all 0.3s ease;
            white-space: nowrap;
        `;

        document.body.appendChild(toast);

        // 显示动画
        setTimeout(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        }, 10);

        // 3秒后自动消失
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }

    // 添加悬停效果
    floatButton.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.1)';
        this.style.boxShadow = '0 4px 15px rgba(0,0,0,0.4)';
    });

    floatButton.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
    });

    // 添加点击事件
    floatButton.addEventListener('click', function() {
        // 执行指定的JavaScript代码
        window.innerHeight = 9e9;

        // 添加点击反馈
        this.style.backgroundColor = '#34a853';
        setTimeout(() => {
            this.style.backgroundColor = '#4285f4';
        }, 200);

        // 显示成功提示
        showSuccessToast();
    });

    // 将按钮添加到页面
    document.body.appendChild(floatButton);

    // 添加提示文本
    floatButton.title = '点击调整页面高度';

})();