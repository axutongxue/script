// ==UserScript==
// @name         ����ҳ��߶ȵ�����
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  �ڷ���ҳ�����Ͻ���Ӹ�����ť����������ҳ��߶Ȳ���ʾ�ɹ���ʾ
// @author       You
// @match        https://*.feishu.cn/*
// @match        https://*.larkoffice.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ����������ť
    const floatButton = document.createElement('div');
    floatButton.innerHTML = '??';

    // ���ð�ť��ʽ
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

    // �����ɹ���ʾ����
    function showSuccessToast() {
        const toast = document.createElement('div');
        toast.innerHTML = '? ����ҳ��߶ȳɹ�';

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

        // ��ʾ����
        setTimeout(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(0)';
        }, 10);

        // 3����Զ���ʧ
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

    // �����ͣЧ��
    floatButton.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.1)';
        this.style.boxShadow = '0 4px 15px rgba(0,0,0,0.4)';
    });

    floatButton.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
    });

    // ��ӵ���¼�
    floatButton.addEventListener('click', function() {
        // ִ��ָ����JavaScript����
        window.innerHeight = 9e9;

        // ��ӵ������
        this.style.backgroundColor = '#34a853';
        setTimeout(() => {
            this.style.backgroundColor = '#4285f4';
        }, 200);

        // ��ʾ�ɹ���ʾ
        showSuccessToast();
    });

    // ����ť��ӵ�ҳ��
    document.body.appendChild(floatButton);

    // �����ʾ�ı�
    floatButton.title = '�������ҳ��߶�';

})();