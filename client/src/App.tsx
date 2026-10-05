import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppLayout } from '@/components/AppLayout';
import { LoginPage, RegisterPage, RequireAuth } from '@/features/auth/AuthPages';
import { OrderPage, OrdersPage } from '@/features/orders/OrderPages';
import { ShopPage } from '@/features/shop/ShopPage';
import { StatusPage } from '@/features/system/StatusPage';

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <ShopPage /> },
      { path: 'status', element: <StatusPage /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      {
        path: 'orders',
        element: (
          <RequireAuth>
            <OrdersPage />
          </RequireAuth>
        ),
      },
      {
        path: 'orders/:id',
        element: (
          <RequireAuth>
            <OrderPage />
          </RequireAuth>
        ),
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
