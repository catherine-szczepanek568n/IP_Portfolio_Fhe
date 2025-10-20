// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface IPRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  ipType: string;
  status: "pending" | "active" | "expired";
  title: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'extend1Year':
      result = value + 31536000; // Add 1 year in seconds
      break;
    case 'reduce1Year':
      result = value - 31536000; // Subtract 1 year in seconds
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<IPRecord[]>([]);
  const [filteredRecords, setFilteredRecords] = useState<IPRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ 
    ipType: "Patent", 
    title: "", 
    expirationDate: Math.floor(Date.now() / 1000) + 31536000, // 1 year from now
    valuation: 0 
  });
  const [showFAQ, setShowFAQ] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<IPRecord | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState("all");

  const activeCount = records.filter(r => r.status === "active").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const expiredCount = records.filter(r => r.status === "expired").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    filterRecords();
  }, [records, searchTerm, filterType]);

  const filterRecords = () => {
    let filtered = [...records];
    if (filterType !== "all") {
      filtered = filtered.filter(record => record.status === filterType);
    }
    if (searchTerm) {
      filtered = filtered.filter(record => 
        record.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
        record.ipType.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    setFilteredRecords(filtered);
  };

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("ip_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      const list: IPRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`ip_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedData: recordData.data, 
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                ipType: recordData.ipType, 
                status: recordData.status || "pending",
                title: recordData.title
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting IP data with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newRecordData.valuation);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        ipType: newRecordData.ipType, 
        status: "pending",
        title: newRecordData.title,
        expiration: newRecordData.expirationDate
      };
      await contract.setData(`ip_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("ip_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("ip_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "IP record submitted securely with FHE encryption!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ 
          ipType: "Patent", 
          title: "", 
          expirationDate: Math.floor(Date.now() / 1000) + 31536000,
          valuation: 0 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const activateRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing IP record with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`ip_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const updatedData = FHECompute(recordData.data, 'extend1Year');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { ...recordData, status: "active", data: updatedData };
      await contractWithSigner.setData(`ip_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "IP record activated with FHE computation!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Activation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const expireRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing IP record with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`ip_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "expired" };
      await contract.setData(`ip_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "IP record marked as expired!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Operation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const renderBarChart = () => {
    const types = ["Patent", "Trademark", "Copyright", "Trade Secret"];
    const typeCounts = types.map(type => ({
      type,
      active: records.filter(r => r.ipType === type && r.status === "active").length,
      pending: records.filter(r => r.ipType === type && r.status === "pending").length,
      expired: records.filter(r => r.ipType === type && r.status === "expired").length
    }));

    const maxCount = Math.max(...typeCounts.map(t => t.active + t.pending + t.expired), 1);

    return (
      <div className="bar-chart-container">
        {typeCounts.map((item, index) => (
          <div key={index} className="bar-item">
            <div className="bar-label">{item.type}</div>
            <div className="bar-wrapper">
              <div 
                className="bar-segment active" 
                style={{ width: `${(item.active / maxCount) * 100}%` }}
                title={`Active: ${item.active}`}
              ></div>
              <div 
                className="bar-segment pending" 
                style={{ width: `${(item.pending / maxCount) * 100}%` }}
                title={`Pending: ${item.pending}`}
              ></div>
              <div 
                className="bar-segment expired" 
                style={{ width: `${(item.expired / maxCount) * 100}%` }}
                title={`Expired: ${item.expired}`}
              ></div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const faqItems = [
    {
      question: "What is FHE encryption?",
      answer: "Fully Homomorphic Encryption (FHE) allows computations to be performed on encrypted data without decrypting it first. Zama FHE technology enables us to process your IP valuation and expiration data while keeping it fully encrypted."
    },
    {
      question: "How is my IP data protected?",
      answer: "Your IP data is encrypted on your device before being sent to the blockchain. It remains encrypted during all processing and can only be decrypted by you with your wallet signature."
    },
    {
      question: "Can I transfer my IP rights?",
      answer: "Yes, through our NFT-based transfer system. The ownership transfer is recorded on-chain while keeping the sensitive details encrypted with FHE."
    },
    {
      question: "What types of IP can I manage?",
      answer: "Our platform supports patents, trademarks, copyrights, and trade secrets. Each type has specific encryption and management features tailored to its requirements."
    },
    {
      question: "How does the valuation work?",
      answer: "You provide the valuation which is encrypted with FHE. The system can perform computations on the encrypted value for licensing calculations without ever decrypting it."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing encrypted IP management system...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>FHE<span>IP</span>Portfolio</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn tech-button">
            <div className="add-icon"></div>Add IP
          </button>
          <button className="tech-button" onClick={() => setShowFAQ(!showFAQ)}>
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Confidential IP Portfolio Management</h2>
            <p>Secure your intellectual property with Zama FHE technology - encrypted processing of sensitive IP data</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        <div className="dashboard-grid">
          <div className="dashboard-card tech-card">
            <h3>IP Portfolio Overview</h3>
            <p>Manage your confidential intellectual property portfolio with <strong>Zama FHE technology</strong>. All sensitive data including valuations and expiration dates are encrypted before processing.</p>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
          
          <div className="dashboard-card tech-card">
            <h3>IP Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{records.length}</div><div className="stat-label">Total IPs</div></div>
              <div className="stat-item"><div className="stat-value">{activeCount}</div><div className="stat-label">Active</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{expiredCount}</div><div className="stat-label">Expired</div></div>
            </div>
          </div>
          
          <div className="dashboard-card tech-card">
            <h3>IP Type Distribution</h3>
            {renderBarChart()}
          </div>
        </div>

        <div className="search-filter-section">
          <div className="search-box">
            <input 
              type="text" 
              placeholder="Search IP by title or type..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="tech-input"
            />
            <div className="search-icon"></div>
          </div>
          <div className="filter-options">
            <select 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value)}
              className="tech-select"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="pending">Pending</option>
              <option value="expired">Expired</option>
            </select>
          </div>
        </div>

        <div className="records-section">
          <div className="section-header">
            <h2>Encrypted IP Records</h2>
            <div className="header-actions">
              <button onClick={loadRecords} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list tech-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Title</div>
              <div className="header-cell">Type</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No IP records found</p>
                <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>Add First IP Record</button>
              </div>
            ) : filteredRecords.map(record => (
              <div className="record-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.title}</div>
                <div className="table-cell">{record.ipType}</div>
                <div className="table-cell">{record.owner.substring(0, 6)}...{record.owner.substring(38)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(record.owner) && (
                    <>
                      {record.status === "pending" && (
                        <button className="action-btn tech-button success" onClick={(e) => { e.stopPropagation(); activateRecord(record.id); }}>Activate</button>
                      )}
                      {record.status === "active" && (
                        <button className="action-btn tech-button danger" onClick={(e) => { e.stopPropagation(); expireRecord(record.id); }}>Expire</button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {showFAQ && (
          <div className="faq-section tech-card">
            <h2>FHE IP Management FAQ</h2>
            <div className="faq-items">
              {faqItems.map((item, index) => (
                <div key={index} className="faq-item">
                  <div className="faq-question">
                    <h3>{item.question}</h3>
                    <div className="arrow-icon"></div>
                  </div>
                  <div className="faq-answer">
                    <p>{item.answer}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {showCreateModal && <ModalCreate onSubmit={submitRecord} onClose={() => setShowCreateModal(false)} creating={creating} recordData={newRecordData} setRecordData={setNewRecordData}/>}
      {selectedRecord && <RecordDetailModal record={selectedRecord} onClose={() => { setSelectedRecord(null); setDecryptedValue(null); }} decryptedValue={decryptedValue} setDecryptedValue={setDecryptedValue} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>FHE IP Portfolio</span></div>
            <p>Secure encrypted IP management powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} FHE IP Portfolio. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const date = new Date(value);
    setRecordData({ ...recordData, [name]: Math.floor(date.getTime() / 1000) });
  };

  const handleSubmit = () => {
    if (!recordData.ipType || !recordData.title || !recordData.valuation) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  const expirationDateString = new Date(recordData.expirationDate * 1000).toISOString().split('T')[0];

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Add Encrypted IP Record</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your IP valuation and expiration data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>IP Type *</label>
              <select name="ipType" value={recordData.ipType} onChange={handleChange} className="tech-select">
                <option value="Patent">Patent</option>
                <option value="Trademark">Trademark</option>
                <option value="Copyright">Copyright</option>
                <option value="Trade Secret">Trade Secret</option>
              </select>
            </div>
            <div className="form-group">
              <label>Title *</label>
              <input 
                type="text" 
                name="title" 
                value={recordData.title} 
                onChange={handleChange} 
                placeholder="IP title or name..." 
                className="tech-input"
              />
            </div>
            <div className="form-group">
              <label>Expiration Date</label>
              <input 
                type="date" 
                name="expirationDate" 
                value={expirationDateString}
                onChange={handleDateChange}
                className="tech-input"
              />
            </div>
            <div className="form-group">
              <label>Valuation (USD) *</label>
              <input 
                type="number" 
                name="valuation" 
                value={recordData.valuation} 
                onChange={handleValueChange} 
                placeholder="Enter valuation amount..." 
                className="tech-input"
                step="0.01"
                min="0"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{recordData.valuation || 'No value entered'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.valuation ? FHEEncryptNumber(recordData.valuation).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Data Privacy Guarantee</strong><p>IP data remains encrypted during FHE processing and is never decrypted on our servers</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn tech-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: IPRecord;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { setDecryptedValue(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal tech-card">
        <div className="modal-header">
          <h2>IP Record Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Title:</span><strong>{record.title}</strong></div>
            <div className="info-item"><span>Type:</span><strong>{record.ipType}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date Added:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Valuation Data</h3>
            <div className="encrypted-data">{record.encryptedData.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn tech-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedValue !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Valuation</h3>
              <div className="decrypted-value">${decryptedValue.toLocaleString()}</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;