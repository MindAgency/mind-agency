'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

export default function OnboardingTour() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('mind-tour-done') === 'true') return;
    
    // Wait until the user is actually inside an agent or group page (not the root loading page)
    if (!pathname || pathname === '/' || pathname === '/setup') return;

    let retryCount = 0;
    const checkAndRun = () => {
      // Check if critical elements exist before running the tour
      if (!document.querySelector('#tour-sidebar-agents') || !document.querySelector('#tour-chat-panel')) {
        if (retryCount < 20) {
          retryCount++;
          setTimeout(checkAndRun, 500);
        }
        return;
      }

      const driverObj = driver({
        showProgress: true,
        allowClose: true,
        doneBtnText: '完成',
        nextBtnText: '下一步',
        prevBtnText: '上一步',
        onDestroyed: () => {
          localStorage.setItem('mind-tour-done', 'true');
        },
        steps: [
          { 
            popover: { 
              title: '欢迎来到 Mind Agency ✨', 
              description: '这是一个由多个 AI Agent 协作的智能平台。让我带你快速了解核心功能吧！',
              side: 'over',
              align: 'center'
            }
          },
          { 
            element: '#tour-sidebar-agents', 
            popover: { 
              title: 'Agent 列表', 
              description: '在这里你可以看到所有的 Agent。每个 Agent 都有独特的角色、性格和长期记忆。', 
              side: 'right', 
              align: 'start' 
            }
          },
          { 
            element: '#tour-sidebar-create', 
            popover: { 
              title: '快速创建', 
              description: '点击这里的加号，即可通过配置或自然语言快速创建新的 Agent 或工作组。', 
              side: 'right', 
              align: 'start' 
            }
          },
          { 
            element: '#tour-chat-panel', 
            popover: { 
              title: '聊天与协作区', 
              description: '这是你与 Agent 交互的主阵地。你可以向他们分配任务，或者输入 /help 查看高级指令。', 
              side: 'left', 
              align: 'center' 
            }
          },
          { 
            element: '#tour-model-selector', 
            popover: { 
              title: '灵活切换模型', 
              description: '在这里你可以一键切换底层的 AI 模型（如 DeepSeek, Claude），还可以开启“深度思考”模式应对复杂问题。', 
              side: 'top', 
              align: 'start' 
            }
          }
        ]
      });
      
      driverObj.drive();
    };

    const timer = setTimeout(checkAndRun, 1000);
    return () => clearTimeout(timer);
  }, [pathname]);

  return null;
}
